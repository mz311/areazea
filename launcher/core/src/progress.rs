use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Checking,
    Downloading,
    Applying,
    Verifying,
    RollingBack,
    Done,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: Phase,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub speed_bps: f64,
    pub eta_secs: Option<u64>,
    pub current: Option<String>,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub type Callback = Arc<dyn Fn(Progress) + Send + Sync>;

struct Inner {
    p: Progress,
    samples: VecDeque<(Instant, u64)>,
    last_emit: Instant,
}

/// Agrège la progression (octets, fichiers, vitesse lissée sur ~3 s) et la publie au plus toutes les 100 ms.
#[derive(Clone)]
pub struct Tracker {
    cb: Callback,
    inner: Arc<Mutex<Inner>>,
}

impl Tracker {
    pub fn new(cb: Callback) -> Self {
        let now = Instant::now();
        Tracker {
            cb,
            inner: Arc::new(Mutex::new(Inner {
                p: Progress { phase: Phase::Checking, bytes_done: 0, bytes_total: 0, files_done: 0, files_total: 0, speed_bps: 0.0, eta_secs: None, current: None },
                samples: VecDeque::from([(now, 0)]),
                last_emit: now - Duration::from_secs(1),
            })),
        }
    }

    pub fn silent() -> Self {
        Self::new(Arc::new(|_| {}))
    }

    pub fn update(&self, f: impl FnOnce(&mut Progress), force: bool) {
        let mut g = self.inner.lock().unwrap();
        f(&mut g.p);
        let now = Instant::now();
        let bytes = g.p.bytes_done;
        g.samples.push_back((now, bytes));
        while g.samples.len() > 2 && now.duration_since(g.samples[0].0) > Duration::from_secs(3) {
            g.samples.pop_front();
        }
        if force || now.duration_since(g.last_emit) >= Duration::from_millis(100) {
            let (t0, b0) = g.samples[0];
            let dt = now.duration_since(t0).as_secs_f64();
            g.p.speed_bps = if dt > 0.2 { bytes.saturating_sub(b0) as f64 / dt } else { g.p.speed_bps };
            g.p.eta_secs = if g.p.speed_bps > 1.0 && g.p.bytes_total > bytes { Some(((g.p.bytes_total - bytes) as f64 / g.p.speed_bps) as u64) } else { None };
            g.last_emit = now;
            let snapshot = g.p.clone();
            drop(g);
            (self.cb)(snapshot);
        }
    }

    pub fn add_bytes(&self, n: u64) {
        self.update(|p| p.bytes_done += n, false);
    }

    pub fn sub_bytes(&self, n: u64) {
        self.update(|p| p.bytes_done = p.bytes_done.saturating_sub(n), false);
    }

    pub fn phase(&self, phase: Phase) {
        self.update(|p| p.phase = phase, true);
    }

    pub fn file_done(&self, current: Option<String>) {
        self.update(
            |p| {
                p.files_done += 1;
                p.current = current;
            },
            false,
        );
    }

    pub fn snapshot(&self) -> Progress {
        self.inner.lock().unwrap().p.clone()
    }
}
