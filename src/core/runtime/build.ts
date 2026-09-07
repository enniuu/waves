declare const __LYRA_BUILD_ID__: string;
declare const __LYRA_RUNTIME_PATHS__: Record<string, string>;

export type RuntimeMount = "bmux" | "epoxy" | "libcurl";

export const clientBuildId =
  typeof __LYRA_BUILD_ID__ === "string" ? __LYRA_BUILD_ID__ : "";

export function runtimeAssetPath(
  mount: RuntimeMount,
  fileName: string,
  buildId = clientBuildId,
): string {
  const relativeFileName = fileName.replace(/^\/+/, "");
  const logicalPath = `${mount}/${relativeFileName}`;
  if (typeof __LYRA_RUNTIME_PATHS__ !== "undefined" && __LYRA_RUNTIME_PATHS__[logicalPath]) {
    return __LYRA_RUNTIME_PATHS__[logicalPath];
  }
  return buildId
    ? `/${mount}/${buildId}/${relativeFileName}`
    : `/${mount}/${relativeFileName}`;
}
