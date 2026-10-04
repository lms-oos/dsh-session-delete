/**
 * dsh-session-delete — client half.
 *
 * Adds one row to the sidebar Session "..." menu (`sidebar.workspaces.session.menu.item`,
 * order 500 — after the shipped pin/rename/fork/archive rows) and owns the
 * confirmation dialog on `shell.overlay` plus the host call that performs the
 * delete.
 *
 * Hand-written bundle: `window.__ModuleLoader__.load({ id, factory })` is the
 * exact shape @deepseek-ai/dsh-client-modules expects, and it needs no build
 * step. Only seed modules are required (React, jsx-runtime, ui-primitives).
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Locale namespace owned by this plugin. */
		var NS = "session-delete";
		/** Host route that removes one session directory. */
		var DELETE_ROUTE = "/session-delete/api/delete";

		var zh = {
			"menu.delete": "删除对话",
			"dialog.title": "删除这条对话？",
			"dialog.body": "将永久删除该对话在磁盘上的完整记录（全部消息与工具调用日志）。此操作不可撤销，也不会进入回收站。",
			"dialog.target": "目标对话",
			"dialog.cancel": "取消",
			"dialog.confirm": "永久删除",
			"dialog.busy": "正在删除…",
			"dialog.failed": "删除失败",
			"dialog.hint": "正在运行的对话需要先停止后才能删除。"
		};
		var en = {
			"menu.delete": "Delete conversation",
			"dialog.title": "Delete this conversation?",
			"dialog.body": "This permanently removes the conversation's stored record from disk (every message and tool-call log). It cannot be undone and does not go to the recycle bin.",
			"dialog.target": "Conversation",
			"dialog.cancel": "Cancel",
			"dialog.confirm": "Delete permanently",
			"dialog.busy": "Deleting…",
			"dialog.failed": "Delete failed",
			"dialog.hint": "A conversation that is running must be stopped before it can be deleted."
		};

		/** Minimal external store — avoids depending on any store package. */
		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				getSnapshot: function () {
					return value;
				},
				subscribe: function (listener) {
					listeners.add(listener);
					return function () {
						listeners.delete(listener);
					};
				},
				set: function (next) {
					value = next;
					listeners.forEach(function (listener) {
						listener();
					});
				}
			};
		}
		function useStore(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		/** The confirmation request: `{ sessionId, title }`, or null when closed. */
		var requestStore = createStore(null);
		/** The in-flight delete: `{ deleting, error }`, or null when idle. */
		var busyStore = createStore(null);
		/** Filled in by apply(): host session-list refresh + diagnostics. */
		var runtime = { refreshSessions: null, log: null };

		/** The menu hook a list entry may not have been given. */
		function noopMenuState() {
			return [false, function () {}];
		}
		function messageOf(error) {
			if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message !== "") return error.message;
			return String(error);
		}

		/** Ask the host to delete one conversation for good. */
		async function deleteSession(sessionId) {
			var response = await fetch(DELETE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sessionId })
			});
			var payload = await response.json().catch(function () {
				return null;
			});
			if (!response.ok || payload === null || payload.ok !== true) {
				var detail = payload !== null && payload !== void 0 && payload.error !== void 0 ? payload.error : void 0;
				throw new Error(detail !== void 0 && typeof detail.message === "string" ? detail.message : "HTTP " + response.status);
			}
			return payload;
		}

		/** Re-pull the host session list so the deleted row disappears. */
		function refreshSessionList() {
			if (runtime.refreshSessions === null) return;
			try {
				runtime.refreshSessions();
			} catch (error) {
				if (runtime.log !== null) runtime.log("session list refresh failed", error);
			}
		}

		/**
		 * One `sidebar.workspaces.session.menu.item` row (order 500).
		 * The menu-open setter arrives as a prop hook, so it is called
		 * unconditionally inside an inner component.
		 */
		function DeleteMenuItemInner(props) {
			var pair = props.useMenuOpenState();
			var setMenuOpen = Array.isArray(pair) ? pair[1] : typeof pair === "function" ? pair : null;
			var t = props.t;
			var title = typeof props.displayTitle === "string" ? props.displayTitle : "";
			var onActivate = function () {
				if (typeof setMenuOpen === "function") {
					try {
						setMenuOpen(false);
					} catch (error) {
						/* a menu that is already closing must not block the dialog */
					}
				}
				busyStore.set(null);
				requestStore.set({ sessionId: props.sessionId, title: title });
			};
			var label = t("menu.delete");
			var icon =
				primitives !== void 0 && primitives.IconTrashOutlineRegular !== void 0
					? jsx(primitives.IconTrashOutlineRegular, { size: 14 })
					: null;
			var MenuItemButton = primitives !== void 0 ? primitives.MenuItemButton : void 0;
			if (typeof MenuItemButton === "function") {
				return jsx(MenuItemButton, { icon: icon, onSelect: onActivate, children: label });
			}
			/* Fallback row: a plain menu item button, styled from theme tokens. */
			return jsxs("button", {
				type: "button",
				role: "menuitem",
				onClick: onActivate,
				style: {
					display: "flex",
					alignItems: "center",
					gap: "8px",
					width: "100%",
					padding: "6px 10px",
					border: "none",
					background: "transparent",
					color: "inherit",
					font: "inherit",
					textAlign: "left",
					cursor: "pointer",
					borderRadius: "var(--dsw-radius-sm, 4px)"
				},
				children: [icon, jsx("span", { children: label })]
			});
		}
		function DeleteSessionMenuItem(props) {
			var merged =
				typeof props.useMenuOpenState === "function"
					? props
					: Object.assign({}, props, { useMenuOpenState: noopMenuState });
			return jsx(DeleteMenuItemInner, merged);
		}

		var overlayStyle = {
			position: "fixed",
			inset: "0",
			zIndex: 40,
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			background: "rgba(0, 0, 0, 0.35)",
			padding: "24px"
		};
		var cardStyle = {
			boxSizing: "border-box",
			width: "min(440px, 100%)",
			display: "flex",
			flexDirection: "column",
			gap: "12px",
			padding: "18px 20px 16px",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.28))",
			background: "var(--dsw-alias-button-elevated-fill, #262626)",
			color: "var(--dsw-alias-label-primary, #eaeaea)",
			boxShadow: "0 18px 48px rgba(0, 0, 0, 0.35)"
		};
		var titleStyle = { fontSize: "15px", fontWeight: 600, lineHeight: "22px" };
		var bodyStyle = {
			fontSize: "13px",
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary, #b8b8b8)"
		};
		var targetStyle = {
			fontSize: "12px",
			lineHeight: "18px",
			padding: "8px 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12))",
			color: "var(--dsw-alias-label-primary, #eaeaea)",
			overflowWrap: "anywhere"
		};
		var errorStyle = {
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-state-error-primary, #e5484d)",
			overflowWrap: "anywhere"
		};
		var actionsStyle = { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "2px" };
		var baseButtonStyle = {
			font: "inherit",
			fontSize: "13px",
			lineHeight: "20px",
			padding: "6px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			cursor: "pointer"
		};
		var secondaryButtonStyle = Object.assign({}, baseButtonStyle, {
			border: "1px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.28))",
			background: "transparent",
			color: "var(--dsw-alias-label-primary, #eaeaea)"
		});
		var dangerButtonStyle = Object.assign({}, baseButtonStyle, {
			border: "1px solid transparent",
			background: "var(--dsw-alias-state-error-primary, #e5484d)",
			color: "#ffffff",
			fontWeight: 600
		});

		/**
		 * The `shell.overlay` entry: nothing while no delete is pending, one
		 * dialog per request. Confirming asks the host to remove the stored
		 * conversation; cancelling touches nothing.
		 */
		function DeleteSessionDialog(props) {
			var request = useStore(requestStore);
			var busy = useStore(busyStore);
			var t = props.t;
			var open = request !== null;
			React.useEffect(
				function () {
					if (!open) return void 0;
					var onKeyDown = function (event) {
						if (event.key !== "Escape") return;
						if (busyStore.getSnapshot() !== null) return;
						event.stopPropagation();
						requestStore.set(null);
					};
					document.addEventListener("keydown", onKeyDown, true);
					return function () {
						document.removeEventListener("keydown", onKeyDown, true);
					};
				},
				[open]
			);
			if (!open) return null;
			var deleting = busy !== null && busy.deleting === true;
			var onCancel = function () {
				if (deleting) return;
				requestStore.set(null);
				busyStore.set(null);
			};
			var onConfirm = function () {
				var current = requestStore.getSnapshot();
				if (current === null || deleting) return;
				busyStore.set({ deleting: true, error: null });
				deleteSession(current.sessionId).then(
					function () {
						busyStore.set(null);
						requestStore.set(null);
						refreshSessionList();
					},
					function (error) {
						busyStore.set({ deleting: false, error: messageOf(error) });
					}
				);
			};
			return jsx("div", {
				style: overlayStyle,
				onMouseDown: function (event) {
					if (event.target === event.currentTarget) onCancel();
				},
				children: jsxs("div", {
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("dialog.title"),
					style: cardStyle,
					children: [
						jsx("div", { style: titleStyle, children: t("dialog.title") }),
						jsx("div", { style: bodyStyle, children: t("dialog.body") }),
						request.title === ""
							? null
							: jsxs("div", {
									style: targetStyle,
									children: [t("dialog.target") + " · ", request.title]
							  }),
						busy !== null && typeof busy.error === "string"
							? jsx("div", { style: errorStyle, children: t("dialog.failed") + ": " + busy.error })
							: jsx("div", { style: bodyStyle, children: t("dialog.hint") }),
						jsxs("div", {
							style: actionsStyle,
							children: [
								jsx("button", {
									type: "button",
									onClick: onCancel,
									disabled: deleting,
									style: secondaryButtonStyle,
									children: t("dialog.cancel")
								}),
								jsx("button", {
									type: "button",
									onClick: onConfirm,
									disabled: deleting,
									style: dangerButtonStyle,
									children: deleting ? t("dialog.busy") : t("dialog.confirm")
								})
							]
						})
					]
				})
			});
		}

		/** Services the client half needs before it can register anything. */
		var inject = ["slots", "locale"];

		/** Locate the live client session service, if this build exposes one. */
		function sessionService(ctx) {
			try {
				if (typeof ctx.get === "function") {
					var found = ctx.get("sessions");
					if (found !== void 0 && found !== null) return found;
				}
			} catch (error) {
				/* service absent in this composition */
			}
			return ctx.sessions !== void 0 ? ctx.sessions : null;
		}

		/**
		 * Register the menu row, the confirmation dialog and the host refresh.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			runtime.log = function (message, error) {
				try {
					if (ctx.logger !== void 0 && typeof ctx.logger.warn === "function") ctx.logger.warn("[dsh-session-delete] " + message, error);
					else console.warn("[dsh-session-delete] " + message, error);
				} catch (ignored) {
					/* logging must never break the delete path */
				}
			};
			runtime.refreshSessions = function () {
				var sessions = sessionService(ctx);
				if (sessions === null) return;
				var candidates = [sessions, sessions.list, sessions.manager];
				for (var index = 0; index < candidates.length; index += 1) {
					var candidate = candidates[index];
					if (candidate !== void 0 && candidate !== null && typeof candidate.refresh === "function") {
						candidate.refresh();
						return;
					}
				}
			};
			ctx.effect(
				function () {
					return ctx.locale.register(NS, { zh: zh, en: en });
				},
				"session-delete: dictionaries"
			);
			ctx.slots.inject("sidebar.workspaces.session.menu.item", function* () {
				yield ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "session-delete",
						order: 500,
						locale: NS
					},
					DeleteSessionMenuItem
				);
			});
			ctx.slots.inject("shell.overlay", function* () {
				yield ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-delete-confirm",
						order: 500,
						locale: NS
					},
					DeleteSessionDialog
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
