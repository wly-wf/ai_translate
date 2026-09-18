//! Owns in-flight model requests. A newer batch cancels obsolete work, including
//! requests waiting for a concurrency permit.
use std::sync::{Arc, Mutex};
use tokio::{sync::Semaphore, task::AbortHandle};

#[derive(Default)]
struct Batch {
    id: u64,
    tasks: Vec<AbortHandle>,
}

pub(crate) struct TranslationRuntime {
    batch: Mutex<Batch>,
    pub permits: Arc<Semaphore>,
}

impl Default for TranslationRuntime {
    fn default() -> Self {
        Self { batch: Mutex::new(Batch::default()), permits: Arc::new(Semaphore::new(4)) }
    }
}

impl TranslationRuntime {
    pub fn begin(&self, id: u64) -> bool {
        let mut batch = self.batch.lock().unwrap_or_else(|error| error.into_inner());
        if id <= batch.id { return false; }
        for task in batch.tasks.drain(..) { task.abort(); }
        batch.id = id;
        true
    }

    pub fn track(&self, id: u64, task: AbortHandle) {
        let mut batch = self.batch.lock().unwrap_or_else(|error| error.into_inner());
        if batch.id == id { batch.tasks.push(task); } else { task.abort(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_batch_cancels_running_and_late_registered_tasks() {
        tauri::async_runtime::block_on(async {
            let runtime = TranslationRuntime::default();
            assert!(runtime.begin(1));
            let old = tokio::spawn(std::future::pending::<()>());
            runtime.track(1, old.abort_handle());
            assert!(runtime.begin(2));
            assert!(old.await.unwrap_err().is_cancelled());
            assert!(!runtime.begin(1));
            let late = tokio::spawn(std::future::pending::<()>());
            runtime.track(1, late.abort_handle());
            assert!(late.await.unwrap_err().is_cancelled());
        });
    }
}
