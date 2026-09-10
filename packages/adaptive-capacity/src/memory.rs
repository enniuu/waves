use std::path::{Component, Path};

pub fn memory_budget(total: u64, available: u64) -> (u64, u64) {
    if !cfg!(target_os = "linux") {
        return (total, available);
    }
    let Ok(membership) = std::fs::read_to_string("/proc/self/cgroup") else {
        return (total, available);
    };
    constrain(total, available, &membership, |path| {
        std::fs::read_to_string(path).ok()
    })
}

fn constrain(
    mut total: u64,
    mut available: u64,
    membership: &str,
    read: impl Fn(&Path) -> Option<String>,
) -> (u64, u64) {
    let Some(group) = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::/"))
    else {
        return (total, available);
    };
    let relative = Path::new(group);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return (total, available);
    }
    let root = Path::new("/sys/fs/cgroup");
    let mut directory = root.join(relative);
    loop {
        let number = |name: &str| {
            read(&directory.join(name)).and_then(|value| value.trim().parse::<u64>().ok())
        };
        let limit = [number("memory.high"), number("memory.max")]
            .into_iter()
            .flatten()
            .min();
        if let Some(limit) = limit {
            total = total.min(limit);
            if let Some(used) = number("memory.current") {
                available = available.min(limit.saturating_sub(used));
            } else {
                available = available.min(limit);
            }
        }
        if directory == root || !directory.pop() {
            break;
        }
    }
    (total, available.min(total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_service_high_and_parent_pressure() {
        let budget = constrain(32_768, 16_384, "0::/proxy.slice/mochi.service\n", |path| {
            Some(
                match path.to_str()? {
                    "/sys/fs/cgroup/proxy.slice/mochi.service/memory.high" => "844",
                    "/sys/fs/cgroup/proxy.slice/mochi.service/memory.max" => "1024",
                    "/sys/fs/cgroup/proxy.slice/mochi.service/memory.current" => "800",
                    "/sys/fs/cgroup/proxy.slice/memory.high" => "2048",
                    "/sys/fs/cgroup/proxy.slice/memory.current" => "2030",
                    _ => return None,
                }
                .to_string(),
            )
        });
        assert_eq!(budget, (844, 18));
    }

    #[test]
    fn over_limit_has_no_headroom_and_root_membership_works() {
        assert_eq!(
            constrain(8192, 4096, "0::/\n", |path| {
                Some(
                    match path.file_name()?.to_str()? {
                        "memory.high" => "max",
                        "memory.max" => "1024",
                        "memory.current" => "1100",
                        _ => return None,
                    }
                    .to_string(),
                )
            }),
            (1024, 0)
        );
    }

    #[test]
    fn missing_unlimited_and_invalid_limits_preserve_host_budget() {
        for value in [None, Some("max"), Some("invalid")] {
            assert_eq!(
                constrain(8192, 4096, "0::/service\n", |_| value.map(str::to_string)),
                (8192, 4096)
            );
        }
        assert_eq!(
            constrain(8192, 4096, "0::/../outside\n", |_| panic!(
                "unexpected read... /ᐠ - ˕ -マ"
            )),
            (8192, 4096)
        );
    }
}
