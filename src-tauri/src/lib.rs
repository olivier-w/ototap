use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use enigo::{Button, Direction, Enigo, Mouse, Settings};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const STATUS_EVENT: &str = "clicker-status";
const GLOBAL_HOTKEY: &str = "CTRL+ALT+A";
const DEFAULT_INTERVAL_MILLISECONDS: u64 = 5_000;
const MIN_INTERVAL_MILLISECONDS: u64 = 100;
const MAX_INTERVAL_MILLISECONDS: u64 = 30_000;

type StopSender = mpsc::Sender<()>;

type ControllerHandle = Arc<Mutex<ClickerController>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPoint {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Ready,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickerStatus {
    status: SessionStatus,
    interval_milliseconds: u64,
    hotkey: String,
    click_count: u64,
    target_point: Option<ScreenPoint>,
    next_click_at: Option<u64>,
    error_message: Option<String>,
}

struct ClickerController {
    status: ClickerStatus,
    hotkey_registered: bool,
    stop_sender: Option<StopSender>,
    worker: Option<JoinHandle<()>>,
}

struct AppState {
    controller: ControllerHandle,
}

impl ClickerController {
    fn new() -> Self {
        Self {
            status: ClickerStatus {
                status: SessionStatus::Ready,
                interval_milliseconds: DEFAULT_INTERVAL_MILLISECONDS,
                hotkey: GLOBAL_HOTKEY.to_string(),
                click_count: 0,
                target_point: None,
                next_click_at: None,
                error_message: None,
            },
            hotkey_registered: false,
            stop_sender: None,
            worker: None,
        }
    }

    fn reap_finished_worker(&mut self) {
        let finished = self.worker.as_ref().is_some_and(JoinHandle::is_finished);

        if finished {
            self.worker.take();
            self.stop_sender.take();
        }
    }
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn validate_interval(interval_milliseconds: u64) -> Result<(), String> {
    if (MIN_INTERVAL_MILLISECONDS..=MAX_INTERVAL_MILLISECONDS).contains(&interval_milliseconds) {
        Ok(())
    } else {
        Err(format!(
            "Interval must be between {MIN_INTERVAL_MILLISECONDS} and {MAX_INTERVAL_MILLISECONDS} milliseconds."
        ))
    }
}

fn hotkey_unavailable_message(hotkey: &str) -> String {
    format!("{hotkey} is unavailable. Record another shortcut.")
}

fn emit_status(app: &AppHandle, controller: &ControllerHandle, status: ClickerStatus) {
    if let Ok(mut guard) = controller.lock() {
        guard.status = status.clone();
    }

    let _ = app.emit(STATUS_EVENT, status);
}

fn worker_loop(
    app: AppHandle,
    controller: ControllerHandle,
    stop_receiver: mpsc::Receiver<()>,
    target_point: ScreenPoint,
    interval_milliseconds: u64,
) {
    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(enigo) => enigo,
        Err(error) => {
            let status = status_after_error(&controller, error.to_string());
            emit_status(&app, &controller, status);
            return;
        }
    };
    let interval = Duration::from_millis(interval_milliseconds);
    let mut next_deadline = Instant::now() + interval;

    loop {
        let wait_time = next_deadline.saturating_duration_since(Instant::now());

        match stop_receiver.recv_timeout(wait_time) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(error) = enigo.button(Button::Left, Direction::Click) {
                    let status = status_after_error(&controller, error.to_string());
                    emit_status(&app, &controller, status);
                    return;
                }

                let status = {
                    let mut guard = match controller.lock() {
                        Ok(guard) => guard,
                        Err(_) => return,
                    };

                    guard.status.click_count = guard.status.click_count.saturating_add(1);
                    guard.status.target_point = Some(ScreenPoint {
                        x: target_point.x,
                        y: target_point.y,
                    });
                    next_deadline = Instant::now() + interval;
                    guard.status.next_click_at =
                        Some(current_time_millis().saturating_add(interval_milliseconds));
                    guard.status.clone()
                };

                let _ = app.emit(STATUS_EVENT, status);
            }
        }
    }
}

fn status_after_error(controller: &ControllerHandle, message: String) -> ClickerStatus {
    let mut guard = match controller.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return ClickerStatus {
                status: SessionStatus::Error,
                interval_milliseconds: DEFAULT_INTERVAL_MILLISECONDS,
                hotkey: GLOBAL_HOTKEY.to_string(),
                click_count: 0,
                target_point: None,
                next_click_at: None,
                error_message: Some(message),
            }
        }
    };

    guard.status.status = SessionStatus::Error;
    guard.status.next_click_at = None;
    guard.status.error_message = Some(message);
    guard.status.clone()
}

fn capture_cursor() -> Result<ScreenPoint, String> {
    let enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
    let (x, y) = enigo.location().map_err(|error| error.to_string())?;
    Ok(ScreenPoint { x, y })
}

fn stop_clicker_internal(app: &AppHandle, controller: &ControllerHandle) -> ClickerStatus {
    let (stop_sender, worker) = {
        let mut guard = match controller.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return ClickerStatus {
                    status: SessionStatus::Error,
                    interval_milliseconds: DEFAULT_INTERVAL_MILLISECONDS,
                    hotkey: GLOBAL_HOTKEY.to_string(),
                    click_count: 0,
                    target_point: None,
                    next_click_at: None,
                    error_message: Some("The clicker state could not be locked.".to_string()),
                }
            }
        };

        (guard.stop_sender.take(), guard.worker.take())
    };

    if let Some(sender) = stop_sender {
        let _ = sender.send(());
    }

    if let Some(worker) = worker {
        let _ = worker.join();
    }

    let status = {
        let mut guard = match controller.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return ClickerStatus {
                    status: SessionStatus::Error,
                    interval_milliseconds: DEFAULT_INTERVAL_MILLISECONDS,
                    hotkey: GLOBAL_HOTKEY.to_string(),
                    click_count: 0,
                    target_point: None,
                    next_click_at: None,
                    error_message: Some("The clicker state could not be locked.".to_string()),
                }
            }
        };

        if guard.status.status == SessionStatus::Running {
            guard.status.status = SessionStatus::Stopped;
        }
        guard.status.next_click_at = None;
        guard.status.clone()
    };

    let _ = app.emit(STATUS_EVENT, status.clone());
    status
}

fn start_clicker_internal(
    app: &AppHandle,
    controller: &ControllerHandle,
    interval_milliseconds: u64,
) -> Result<ClickerStatus, String> {
    validate_interval(interval_milliseconds)?;

    let target_point = capture_cursor()?;
    let (stop_sender, stop_receiver) = mpsc::channel();
    let controller_for_worker = Arc::clone(controller);
    let app_for_worker = app.clone();

    let status = {
        let mut guard = controller
            .lock()
            .map_err(|_| "The clicker state could not be locked.".to_string())?;
        guard.reap_finished_worker();

        if guard.status.status == SessionStatus::Running || guard.worker.is_some() {
            return Err("The clicker is already running.".to_string());
        }

        let hotkey = guard.status.hotkey.clone();
        let error_message = if guard.hotkey_registered {
            None
        } else {
            Some(hotkey_unavailable_message(&hotkey))
        };
        guard.status = ClickerStatus {
            status: SessionStatus::Running,
            interval_milliseconds,
            hotkey,
            click_count: 0,
            target_point: Some(ScreenPoint {
                x: target_point.x,
                y: target_point.y,
            }),
            next_click_at: Some(current_time_millis().saturating_add(interval_milliseconds)),
            error_message,
        };
        guard.stop_sender = Some(stop_sender);
        guard.status.clone()
    };

    let worker = thread::spawn(move || {
        worker_loop(
            app_for_worker,
            controller_for_worker,
            stop_receiver,
            target_point,
            interval_milliseconds,
        );
    });

    if let Ok(mut guard) = controller.lock() {
        guard.worker = Some(worker);
    }

    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

fn toggle_clicker_internal(
    app: &AppHandle,
    controller: &ControllerHandle,
) -> Result<ClickerStatus, String> {
    let should_stop = controller
        .lock()
        .map_err(|_| "The clicker state could not be locked.".to_string())?
        .status
        .status
        == SessionStatus::Running;

    if should_stop {
        return Ok(stop_clicker_internal(app, controller));
    }

    let interval_milliseconds = controller
        .lock()
        .map_err(|_| "The clicker state could not be locked.".to_string())?
        .status
        .interval_milliseconds;
    start_clicker_internal(app, controller, interval_milliseconds)
}

#[tauri::command]
fn set_interval(
    app: AppHandle,
    state: State<'_, AppState>,
    interval_milliseconds: u64,
) -> Result<ClickerStatus, String> {
    validate_interval(interval_milliseconds)?;

    let status = {
        let mut guard = state
            .controller
            .lock()
            .map_err(|_| "The clicker state could not be locked.".to_string())?;

        if guard.status.status == SessionStatus::Running {
            return Err("Stop the clicker before changing the interval.".to_string());
        }

        guard.status.interval_milliseconds = interval_milliseconds;
        guard.status.error_message = if guard.hotkey_registered {
            None
        } else {
            Some(hotkey_unavailable_message(&guard.status.hotkey))
        };
        guard.status.clone()
    };

    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> Result<ClickerStatus, String> {
    let hotkey = hotkey.trim().to_uppercase();

    if !hotkey.contains('+') {
        return Err("Use at least one modifier and one key for the shortcut.".to_string());
    }

    let (current_hotkey, current_status, current_hotkey_registered) = {
        let guard = state
            .controller
            .lock()
            .map_err(|_| "The clicker state could not be locked.".to_string())?;
        (
            guard.status.hotkey.clone(),
            guard.status.clone(),
            guard.hotkey_registered,
        )
    };

    if hotkey == current_hotkey && current_hotkey_registered {
        return Ok(current_status);
    }

    app.global_shortcut()
        .register(hotkey.as_str())
        .map_err(|error| format!("That shortcut is unavailable: {error}"))?;

    if current_hotkey_registered && hotkey != current_hotkey {
        if let Err(error) = app.global_shortcut().unregister(current_hotkey.as_str()) {
            let _ = app.global_shortcut().unregister(hotkey.as_str());
            return Err(format!(
                "The previous shortcut could not be replaced: {error}"
            ));
        }
    }

    let status = match state.controller.lock() {
        Ok(mut guard) => {
            guard.status.hotkey = hotkey.clone();
            guard.status.error_message = None;
            guard.hotkey_registered = true;
            guard.status.clone()
        }
        Err(_) => {
            let _ = app.global_shortcut().unregister(hotkey.as_str());
            if current_hotkey_registered && hotkey != current_hotkey {
                let _ = app.global_shortcut().register(current_hotkey.as_str());
            }
            return Err("The clicker state could not be locked.".to_string());
        }
    };

    let _ = app.emit(STATUS_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
fn start_clicker(
    app: AppHandle,
    state: State<'_, AppState>,
    interval_milliseconds: u64,
) -> Result<ClickerStatus, String> {
    start_clicker_internal(&app, &state.controller, interval_milliseconds)
}

#[tauri::command]
fn stop_clicker(app: AppHandle, state: State<'_, AppState>) -> ClickerStatus {
    stop_clicker_internal(&app, &state.controller)
}

#[tauri::command]
fn toggle_clicker(app: AppHandle, state: State<'_, AppState>) -> Result<ClickerStatus, String> {
    toggle_clicker_internal(&app, &state.controller)
}

#[tauri::command]
fn get_clicker_status(state: State<'_, AppState>) -> Result<ClickerStatus, String> {
    state
        .controller
        .lock()
        .map(|guard| guard.status.clone())
        .map_err(|_| "The clicker state could not be locked.".to_string())
}

fn create_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show OtoTap", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Start / Stop", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &toggle_item, &quit_item])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("OtoTap auto clicker")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle" => {
                let state = app.state::<AppState>();
                let _ = toggle_clicker_internal(app, &state.controller);
            }
            "quit" => {
                let state = app.state::<AppState>();
                let _ = stop_clicker_internal(app, &state.controller);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let controller = Arc::new(Mutex::new(ClickerController::new()));
    let state = AppState { controller };

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, pressed_shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let state = app.state::<AppState>();
                    let configured_hotkey = match state.controller.lock() {
                        Ok(guard) => guard.status.hotkey.clone(),
                        Err(_) => return,
                    };

                    if let Ok(configured_shortcut) = configured_hotkey.parse::<Shortcut>() {
                        if pressed_shortcut == &configured_shortcut {
                            let _ = toggle_clicker_internal(app, &state.controller);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let registration_result = app.global_shortcut().register(GLOBAL_HOTKEY);
            let state = app.state::<AppState>();

            if let Ok(mut guard) = state.controller.lock() {
                match registration_result {
                    Ok(()) => {
                        guard.hotkey_registered = true;
                        guard.status.error_message = None;
                    }
                    Err(_) => {
                        guard.hotkey_registered = false;
                        guard.status.error_message =
                            Some(hotkey_unavailable_message(GLOBAL_HOTKEY));
                    }
                }
            }

            create_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_interval,
            set_hotkey,
            start_clicker,
            stop_clicker,
            toggle_clicker,
            get_clicker_status
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OtoTap")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                let _ = stop_clicker_internal(app, &state.controller);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        hotkey_unavailable_message, validate_interval, ClickerController, SessionStatus,
        DEFAULT_INTERVAL_MILLISECONDS, GLOBAL_HOTKEY, MAX_INTERVAL_MILLISECONDS,
        MIN_INTERVAL_MILLISECONDS,
    };

    #[test]
    fn validates_supported_interval_bounds() {
        assert!(validate_interval(MIN_INTERVAL_MILLISECONDS).is_ok());
        assert!(validate_interval(MAX_INTERVAL_MILLISECONDS).is_ok());
        assert!(validate_interval(0).is_err());
        assert!(validate_interval(MAX_INTERVAL_MILLISECONDS + 1).is_err());
    }

    #[test]
    fn default_status_contract_stays_ready() {
        let controller = ClickerController::new();

        assert_eq!(controller.status.status, SessionStatus::Ready);
        assert_eq!(controller.status.interval_milliseconds, 5_000);
        assert_eq!(DEFAULT_INTERVAL_MILLISECONDS, 5_000);
        assert!(!controller.hotkey_registered);
        assert!(hotkey_unavailable_message(GLOBAL_HOTKEY).contains(GLOBAL_HOTKEY));
    }
}
