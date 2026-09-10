use sysinfo::{Disks, System};

pub struct MochiTuning {
    pub worker_threads: usize,
    pub cache_capacity_bytes: u64,
    pub stream_cache_capacity_bytes: u64,
    pub cache_ttl_secs: u64,
    pub max_cache_entry_size: usize,
    pub stream_max_entry_size: usize,
    pub ram_cache_limit: usize,
    pub pool_idle_per_host_asset: usize,
    pub pool_idle_per_host_html: usize,
    pub pool_idle_timeout_secs: u64,
    pub request_permits_min: usize,
    pub request_permits: usize,
    pub request_permits_max: usize,
    pub stream_upstream_permits_min: usize,
    pub stream_upstream_permits: usize,
    pub stream_upstream_permits_max: usize,
    pub html_rewrite_permits_min: usize,
    pub html_rewrite_permits: usize,
    pub html_rewrite_permits_max: usize,
    pub disk_cache_bytes: u64,
    pub disk_max_age_secs: u64,
    pub disk_cleanup_interval_secs: u64,
    pub channel_buffer: usize,
}

pub fn detect() -> MochiTuning {
    let mut sys = System::new();
    sys.refresh_memory();
    let instances = std::env::var("MOCHI_INSTANCES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|count| (1..=32).contains(count))
        .unwrap_or(1);
    let (memory_bytes, _) =
        adaptive_capacity::memory_budget(sys.total_memory(), sys.available_memory());
    let ram_mb = (sys.total_memory() / instances).min(memory_bytes) / (1024 * 1024);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .div_ceil(instances as usize);

    let disks = Disks::new_with_refreshed_list();
    let current_dir = std::env::current_dir().unwrap_or_default();
    let disk_mb = disks
        .list()
        .iter()
        .filter(|disk| current_dir.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space() / (1024 * 1024))
        .unwrap_or(10_000);

    tracing::info!(
        "detected system: {}mb ram, {} cores, {}mb disk",
        ram_mb,
        cores,
        disk_mb
    );

    let mut tuning = compute(ram_mb, cores, disk_mb);
    if let Ok(gb) = std::env::var("MOCHI_STREAM_CACHE_GB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(())
    {
        let requested = gb.clamp(1, 1024) * 1024 * 1024 * 1024;
        let safe_limit = (disk_mb * 1024 * 1024).saturating_mul(3) / 4;
        tuning.disk_cache_bytes = requested.min(safe_limit.max(1024 * 1024 * 1024));
    }
    if let Some(days) = std::env::var("MOCHI_STREAM_CACHE_TTL_DAYS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        tuning.disk_max_age_secs = days.clamp(1, 30) * 24 * 3600;
    }
    if let Some(permits) = std::env::var("MOCHI_STREAM_UPSTREAM_PERMITS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
    {
        tuning.stream_upstream_permits_max = permits
            .max(tuning.stream_upstream_permits_min)
            .min(tuning.stream_upstream_permits_max);
        tuning.stream_upstream_permits = tuning
            .stream_upstream_permits
            .min(tuning.stream_upstream_permits_max);
    }
    tuning
}

fn compute(ram_mb: u64, cores: usize, disk_mb: u64) -> MochiTuning {
    let worker_threads = cores
        .saturating_sub(1)
        .max(1)
        .min((ram_mb / 384).max(1) as usize);

    let cache_cap_mb = (ram_mb / 48).clamp(64, 4096);
    let cache_capacity_bytes = cache_cap_mb * 1024 * 1024;
    let stream_cache_cap_mb = (ram_mb / 24).clamp(128, 2048);
    let stream_cache_capacity_bytes = stream_cache_cap_mb * 1024 * 1024;

    let max_entry_mb = (cache_cap_mb / 4).clamp(16, 512);
    let max_cache_entry_size = (max_entry_mb as usize) * 1024 * 1024;
    let stream_max_entry_mb = (ram_mb / 1024).clamp(8, 32);
    let stream_max_entry_size = (stream_max_entry_mb as usize) * 1024 * 1024;

    let ram_limit_mb = (ram_mb / 512).clamp(8, 64);
    let ram_cache_limit = (ram_limit_mb as usize) * 1024 * 1024;

    let cache_ttl_secs = if ram_mb < 8192 { 24 * 3600 } else { 48 * 3600 };

    let pool_idle_per_host_asset = (cores * 3).clamp(4, 32);
    let pool_idle_per_host_html = (cores * 2).clamp(2, 16);
    let pool_idle_timeout_secs = if ram_mb < 8192 { 120 } else { 300 };

    let request_permits_min = cores
        .saturating_mul(4)
        .clamp(8, 64)
        .min((ram_mb / 32).max(1) as usize);
    let request_permits_max = cores
        .saturating_mul(64)
        .min((ram_mb / 32).max(request_permits_min as u64) as usize)
        .clamp(request_permits_min, 1024);
    let request_permits = cores
        .saturating_mul(24)
        .clamp(request_permits_min, request_permits_max);
    let stream_upstream_permits_min = cores.clamp(2, 8);
    let stream_upstream_permits_max = cores
        .saturating_mul(8)
        .min((ram_mb / 64).max(stream_upstream_permits_min as u64) as usize)
        .clamp(stream_upstream_permits_min, 256);
    let stream_upstream_permits = cores
        .saturating_mul(2)
        .clamp(stream_upstream_permits_min, stream_upstream_permits_max);
    let html_rewrite_permits_min = 1;
    let html_rewrite_permits_max = cores
        .saturating_mul(4)
        .min((ram_mb / 128).max(1) as usize)
        .clamp(html_rewrite_permits_min, 64);
    let html_rewrite_permits = cores.clamp(html_rewrite_permits_min, html_rewrite_permits_max);
    let disk_cache_gb = (disk_mb / 1024 / 60).clamp(1, 20);
    let disk_cache_bytes = disk_cache_gb * 1024 * 1024 * 1024;
    let disk_max_age_secs = if disk_mb < 100_000 {
        24 * 3600
    } else {
        48 * 3600
    };
    let disk_cleanup_interval_secs = if disk_mb < 100_000 { 900 } else { 1800 };

    let channel_buffer = if ram_mb < 8192 {
        16
    } else if ram_mb < 16384 {
        32
    } else {
        64
    };

    MochiTuning {
        worker_threads,
        cache_capacity_bytes,
        stream_cache_capacity_bytes,
        cache_ttl_secs,
        max_cache_entry_size,
        stream_max_entry_size,
        ram_cache_limit,
        pool_idle_per_host_asset,
        pool_idle_per_host_html,
        pool_idle_timeout_secs,
        request_permits_min,
        request_permits,
        request_permits_max,
        stream_upstream_permits_min,
        stream_upstream_permits,
        stream_upstream_permits_max,
        html_rewrite_permits_min,
        html_rewrite_permits,
        html_rewrite_permits_max,
        disk_cache_bytes,
        disk_max_age_secs,
        disk_cleanup_interval_secs,
        channel_buffer,
    }
}

#[cfg(test)]
mod tests {
    use super::compute;

    #[test]
    fn bounds_requests_within_a_small_service_budget() {
        for cores in [1, 8, 64] {
            let tuning = compute(844, cores, 100_000);
            assert!(tuning.request_permits_max <= 26);
            assert!(tuning.request_permits <= tuning.request_permits_max);
            assert!(tuning.request_permits_min <= tuning.request_permits);
        }
    }

    #[test]
    fn keeps_stream_entries_small_on_every_host_size() {
        const MIB: usize = 1024 * 1024;
        assert_eq!(compute(4_096, 4, 100_000).stream_max_entry_size, 8 * MIB);
        assert_eq!(compute(24_576, 8, 100_000).stream_max_entry_size, 24 * MIB);
        assert_eq!(
            compute(131_072, 16, 100_000).stream_max_entry_size,
            32 * MIB
        );
    }

    #[test]
    fn bounds_in_flight_memory_and_work() {
        let normal = compute(8_192, 8, 100_000);
        assert_eq!(normal.request_permits, 192);
        assert_eq!(normal.stream_upstream_permits, 16);
        assert_eq!(normal.html_rewrite_permits, 8);
        assert_eq!(normal.ram_cache_limit, 16 * 1024 * 1024);
        assert!(normal.request_permits_min < normal.request_permits_max);
        assert!(normal.stream_upstream_permits_min < normal.stream_upstream_permits_max);

        let large = compute(131_072, 128, 1_000_000);
        assert_eq!(large.worker_threads, 127);
        assert_eq!(large.request_permits, 1024);
        assert_eq!(large.stream_upstream_permits, 256);
        assert_eq!(large.html_rewrite_permits, 64);
        assert_eq!(large.channel_buffer, 64);
    }
}
