import { ManagedPlugin } from "@mercuryworkshop/folio-controller";
import type { Frame } from "@mercuryworkshop/folio-controller";

export type LinkHandlerPluginOptions = {
	includeModifierClicks?: boolean;
};

type WindowWithPatchedOpen = Window &
	typeof globalThis & {
	open: typeof window.open & { __folioLinkHandlerPatched?: boolean };
};

const SAME_CONTEXT_TARGETS = new Set(["", "_self", "_top", "_parent"]);

function eventPath(event: Event): EventTarget[] {
	return event.composedPath();
}

function closestFromEvent<T extends Element>(
	event: Event,
	matches: (node: Element) => node is T
): T | null {
	for (const node of eventPath(event)) {
		if (
			typeof node === "object" &&
			node !== null &&
			"nodeType" in node &&
			node.nodeType === 1 &&
			matches(node as Element)
		)
			return node as T;
	}
	return null;
}

function targetCreatesNewContext(target: string | null | undefined): boolean {
	const normalized = (target ?? "").trim().toLowerCase();
	return !SAME_CONTEXT_TARGETS.has(normalized);
}

function baseTargetCreatesNewContext(document: Document): boolean {
	return targetCreatesNewContext(
		document.querySelector("base[target]")?.getAttribute("target")
	);
}

export class LinkHandlerPlugin extends ManagedPlugin {
	constructor(
		private onNewTab: (url: string, active: boolean) => void,
		private options: LinkHandlerPluginOptions = {}
	) {
		super("link-handler", []);
	}

	private open(url: string | URL, window: Window, active = true): boolean {
		try {
			this.onNewTab(new URL(String(url), window.location.href).href, active);
			return true;
		} catch {
			return false;
		}
	}

	private consume(event: Event, url: string | URL, window: Window, active = true): void {
		if (!this.open(url, window, active)) return;

		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
	}

	install(frame: Frame): void {
		this.tap(
			frame.hooks.init.post,
			(context) => {
				const window = context.window as WindowWithPatchedOpen;
				const document = window.document;

				const shouldOpenAnchorInNewTab = (
					anchor: HTMLAnchorElement | HTMLAreaElement,
					event: MouseEvent
				): boolean => {
					if (!anchor.href) return false;
					if (event.button === 1) return true;
					if (
						this.options.includeModifierClicks !== false &&
						event.button === 0 &&
						(event.ctrlKey || event.metaKey)
					)
						return true;

					const target = anchor.getAttribute("target");
					if (targetCreatesNewContext(target)) return true;
					if (!target && baseTargetCreatesNewContext(document)) return true;

					return false;
				};

				const anchorClickHandler = (event: MouseEvent) => {
					if (event.button !== 0 && event.button !== 1) return;

					const anchor = closestFromEvent(
						event,
						(node): node is HTMLAnchorElement | HTMLAreaElement =>
							node instanceof window.HTMLAnchorElement ||
							node instanceof window.HTMLAreaElement
					);
					if (!anchor || !shouldOpenAnchorInNewTab(anchor, event)) return;

					this.consume(event, anchor.href, window,
						(event.button === 1 || event.ctrlKey || event.metaKey) ? event.shiftKey : true);
				};

				document.addEventListener("click", anchorClickHandler, true);
				document.addEventListener("auxclick", anchorClickHandler, true);

				document.addEventListener("submit", (event: SubmitEvent) => {
					const form = closestFromEvent(
						event,
						(node): node is HTMLFormElement =>
							node instanceof window.HTMLFormElement
					);
					if (!form) return;

					const submitter =
						event.submitter instanceof window.HTMLElement
							? event.submitter
							: null;
					const submitterTarget = submitter?.getAttribute("formtarget");
					const formTarget = form.getAttribute("target");
					const target = submitterTarget || formTarget;
					const opensNewContext =
						targetCreatesNewContext(target) ||
						(!target && baseTargetCreatesNewContext(document));
					if (!opensNewContext) return;

					const action =
						submitter?.getAttribute("formaction") ||
						form.getAttribute("action") ||
						window.location.href;
					this.consume(event, action, window);
				}, true);

				if (!window.open.__folioLinkHandlerPatched) {
					const originalOpen = window.open;
					window.open = ((url?: string | URL, target?: string, features?: string) => {
						if (
							url &&
							(!target || targetCreatesNewContext(target)) &&
							this.open(url, window)
						)
							return null;

						return originalOpen.call(window, url, target, features);
					}) as WindowWithPatchedOpen["open"];
					window.open.__folioLinkHandlerPatched = true;
				}
			},
			{ after: ["event-handler"] }
		);
	}
}
