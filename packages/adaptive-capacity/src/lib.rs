use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;
use tokio::sync::Notify;

mod memory;
pub use memory::memory_budget;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workload {
    Cpu,
    Mixed,
    Io,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostResources {
    pub cores: usize,
    pub memory_bytes: u64,
}

impl HostResources {
    pub fn detect() -> Self {
        let mut system = System::new();
        system.refresh_memory();
        Self {
            cores: std::thread::available_parallelism()
                .map(|cores| cores.get())
                .unwrap_or(1),
            memory_bytes: system.total_memory().max(256 * 1024 * 1024),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateSnapshot {
    pub active: usize,
    pub limit: usize,
    pub minimum: usize,
    pub maximum: usize,
    pub peak: usize,
    pub waits: u64,
    pub rejected: u64,
}

pub struct AdaptiveGate {
    minimum: usize,
    maximum: usize,
    limit: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    waits: AtomicU64,
    rejected: AtomicU64,
    notify: Notify,
}

impl AdaptiveGate {
    pub fn new(minimum: usize, initial: usize, maximum: usize) -> Arc<Self> {
        let minimum = minimum.max(1);
        let maximum = maximum.max(minimum);
        let initial = initial.clamp(minimum, maximum);
        Arc::new(Self {
            minimum,
            maximum,
            limit: AtomicUsize::new(initial),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            waits: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            notify: Notify::new(),
        })
    }

    fn enter(self: &Arc<Self>) -> Option<AdaptivePermit> {
        loop {
            let active = self.active.load(Ordering::Acquire);
            if active >= self.limit.load(Ordering::Acquire) {
                return None;
            }
            if self
                .active
                .compare_exchange_weak(active, active + 1, Ordering::AcqRel, Ordering::Relaxed)
                .is_ok()
            {
                self.peak.fetch_max(active + 1, Ordering::Relaxed);
                return Some(AdaptivePermit { gate: self.clone() });
            }
        }
    }

    pub fn try_acquire(self: &Arc<Self>) -> Option<AdaptivePermit> {
        let permit = self.enter();
        if permit.is_none() {
            self.rejected.fetch_add(1, Ordering::Relaxed);
        }
        permit
    }

    pub async fn acquire(self: &Arc<Self>) -> AdaptivePermit {
        let mut waited = false;
        loop {
            let notified = self.notify.notified();
            if let Some(permit) = self.enter() {
                if waited {
                    self.waits.fetch_add(1, Ordering::Relaxed);
                }
                return permit;
            }
            waited = true;
            notified.await;
        }
    }

    pub async fn acquire_timeout(self: &Arc<Self>, duration: Duration) -> Option<AdaptivePermit> {
        let deadline = tokio::time::Instant::now() + duration;
        let mut waited = false;
        loop {
            let notified = self.notify.notified();
            if let Some(permit) = self.enter() {
                if waited {
                    self.waits.fetch_add(1, Ordering::Relaxed);
                }
                return Some(permit);
            }
            waited = true;
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                self.waits.fetch_add(1, Ordering::Relaxed);
                self.rejected.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        }
    }

    pub fn set_limit(&self, limit: usize) {
        let limit = limit.clamp(self.minimum, self.maximum);
        let previous = self.limit.swap(limit, Ordering::AcqRel);
        if limit > previous {
            self.notify.notify_waiters();
        }
    }

    pub fn snapshot(&self) -> GateSnapshot {
        GateSnapshot {
            active: self.active.load(Ordering::Relaxed),
            limit: self.limit.load(Ordering::Relaxed),
            minimum: self.minimum,
            maximum: self.maximum,
            peak: self.peak.load(Ordering::Relaxed),
            waits: self.waits.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
        }
    }
}

pub struct AdaptivePermit {
    gate: Arc<AdaptiveGate>,
}

impl Drop for AdaptivePermit {
    fn drop(&mut self) {
        self.gate.active.fetch_sub(1, Ordering::AcqRel);
        self.gate.notify.notify_one();
    }
}

#[derive(Clone)]
pub struct CapacityTarget {
    pub gate: Arc<AdaptiveGate>,
    pub memory_per_permit: u64,
    pub workload: Workload,
}

impl CapacityTarget {
    pub fn new(gate: Arc<AdaptiveGate>, memory_per_permit: u64, workload: Workload) -> Self {
        Self {
            gate,
            memory_per_permit: memory_per_permit.max(1),
            workload,
        }
    }
}

fn next_limit(
    snapshot: GateSnapshot,
    target: &CapacityTarget,
    available_memory: u64,
    target_count: usize,
    normalized_load: f64,
    cores: usize,
) -> usize {
    let active = snapshot.active;
    let share = available_memory
        .saturating_div(target_count.max(1) as u64)
        .saturating_div(2);
    let memory_growth = share.saturating_div(target.memory_per_permit) as usize;
    let memory_limit = memory_growth.max(snapshot.minimum);
    let cpu_limit = match target.workload {
        Workload::Cpu => ((cores as f64) / normalized_load.max(0.5)).ceil() as usize,
        Workload::Mixed => {
            ((cores.saturating_mul(4) as f64) / normalized_load.max(0.75)).ceil() as usize
        }
        Workload::Io => snapshot.maximum,
    }
    .max(snapshot.minimum);
    let safe_limit = memory_limit
        .min(cpu_limit)
        .clamp(snapshot.minimum, snapshot.maximum);

    if safe_limit < snapshot.limit {
        return safe_limit.max((snapshot.limit + snapshot.minimum) / 2);
    }
    if active >= snapshot.limit && safe_limit > snapshot.limit {
        let growth = (safe_limit - snapshot.limit).div_ceil(4).max(1);
        return snapshot.limit.saturating_add(growth).min(safe_limit);
    }
    snapshot.limit
}

pub fn spawn_rebalancer(
    targets: Vec<CapacityTarget>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut system = System::new();
        let cores = std::thread::available_parallelism()
            .map(|cores| cores.get())
            .unwrap_or(1);
        let mut ticker = tokio::time::interval(interval.max(Duration::from_millis(250)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            system.refresh_memory();
            let (_, available_memory) =
                memory_budget(system.total_memory(), system.available_memory());
            let normalized_load = System::load_average().one / cores.max(1) as f64;
            for target in &targets {
                let snapshot = target.gate.snapshot();
                let limit = next_limit(
                    snapshot,
                    target,
                    available_memory,
                    targets.len(),
                    normalized_load,
                    cores,
                );
                target.gate.set_limit(limit);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_runtime_limit_changes() {
        let gate = AdaptiveGate::new(1, 2, 4);
        let first = gate.try_acquire().unwrap();
        let second = gate.try_acquire().unwrap();
        assert!(gate.try_acquire().is_none());
        gate.set_limit(1);
        drop(first);
        assert!(gate.try_acquire().is_none());
        drop(second);
        assert!(gate.try_acquire().is_some());
    }

    #[test]
    fn grows_only_when_saturated_and_shrinks_under_pressure() {
        let gate = AdaptiveGate::new(1, 4, 32);
        let target = CapacityTarget::new(gate, 1024, Workload::Io);
        let idle = GateSnapshot {
            active: 1,
            limit: 4,
            minimum: 1,
            maximum: 32,
            peak: 1,
            waits: 0,
            rejected: 0,
        };
        assert_eq!(next_limit(idle, &target, 1024 * 1024, 1, 0.1, 8), 4);
        let saturated = GateSnapshot { active: 4, ..idle };
        assert!(next_limit(saturated, &target, 1024 * 1024, 1, 0.1, 8) > 4);
        let pressured = GateSnapshot { active: 4, ..idle };
        assert!(next_limit(pressured, &target, 1024, 1, 0.1, 8) < 4);
    }
}
