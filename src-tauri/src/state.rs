//! Shared shell state.
//!
//! Kept in its own module so the tray, the IPC commands and the boot thread can
//! all reach it without importing each other.

use crate::config::DesktopConfig;
#[cfg(desktop)]
use crate::server::Running;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootStage {
    /// One of: setup | starting | ready | error.
    pub stage: String,
    pub message: String,
    pub detail: String,
    pub url: String,
    pub tail: Vec<String>,
}

impl BootStage {
    pub fn starting(message: impl Into<String>) -> Self {
        Self {
            stage: "starting".into(),
            message: message.into(),
            detail: String::new(),
            url: String::new(),
            tail: vec![],
        }
    }

    pub fn ready(url: impl Into<String>) -> Self {
        Self {
            stage: "ready".into(),
            message: "就绪".into(),
            detail: String::new(),
            url: url.into(),
            tail: vec![],
        }
    }

    #[cfg_attr(not(desktop), allow(dead_code))]
    pub fn error(message: impl Into<String>, detail: impl Into<String>, tail: Vec<String>) -> Self {
        Self {
            stage: "error".into(),
            message: message.into(),
            detail: detail.into(),
            url: String::new(),
            tail,
        }
    }

    /// Nothing is running and nothing is *going* to run until the user acts.
    ///
    /// No current build reaches this state — it is kept because the webview
    /// still receives a stage object on every launch, and "there is something
    /// this device cannot do without input" is a legitimate future answer.
    #[allow(dead_code)]
    pub fn setup(message: impl Into<String>) -> Self {
        Self {
            stage: "setup".into(),
            message: message.into(),
            detail: String::new(),
            url: String::new(),
            tail: vec![],
        }
    }
}

pub struct AppState {
    /// The supervised child process. `None` on mobile, and also `None` on
    /// desktop in remote mode.
    #[cfg(desktop)]
    pub server: Mutex<Option<Running>>,
    pub config: Mutex<DesktopConfig>,
    pub stage: Mutex<BootStage>,
    pub data_dir: PathBuf,
    /// Set when the user explicitly quits, so the close-to-tray handler lets
    /// the window actually close.
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new(config: DesktopConfig, data_dir: PathBuf) -> Self {
        Self {
            #[cfg(desktop)]
            server: Mutex::new(None),
            config: Mutex::new(config),
            stage: Mutex::new(BootStage::starting("正在准备…")),
            data_dir,
            quitting: AtomicBool::new(false),
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn base_url(&self) -> String {
        #[cfg(desktop)]
        {
            return self
                .server
                .lock()
                .ok()
                .and_then(|s| s.as_ref().map(|r| r.url.clone()))
                .unwrap_or_default();
        }
        #[allow(unreachable_code)]
        String::new()
    }

    /// Remove and return the running server, if any.
    ///
    /// Wrapped in a method so callers never hold a `MutexGuard` across a
    /// `shutdown()` call — the guard's temporary lives to the end of the
    /// enclosing statement, which does not outlive the `State` borrow.
    #[cfg(desktop)]
    pub fn take_server(&self) -> Option<Running> {
        self.server.lock().ok().and_then(|mut guard| guard.take())
    }

    /// Swap in a new server, returning the previous one for shutdown.
    #[cfg(desktop)]
    pub fn replace_server(&self, running: Running) -> Option<Running> {
        self.server
            .lock()
            .ok()
            .and_then(|mut guard| guard.replace(running))
    }

    #[cfg(desktop)]
    pub fn with_server<T>(&self, f: impl FnOnce(&Running) -> T) -> Option<T> {
        let guard = self.server.lock().ok()?;
        guard.as_ref().map(f)
    }

    pub fn set_stage(&self, stage: BootStage) {
        if let Ok(mut guard) = self.stage.lock() {
            *guard = stage;
        }
    }

    pub fn stage(&self) -> BootStage {
        self.stage
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| BootStage::starting("…"))
    }
}
