const manualBoard = () => frame.board?.settings.boardType === "manual";
const manualColumns = () => frame.board?.settings.manualColumns ?? [];
const api = window.taskboard;
const byId = id => document.getElementById(id);
let frame = {};
let projectGeneration = 0;
let archiveView = false;
let sheetKind = "";
let taskInSheet;
let taskSheetRequest = 0;
let focusBeforeSheet;
let boardTags = new Map();
let lanePreferences = {};
let cardCoverCache = new Map();
let boardCards = new Map();
let boardLanes = new Map();
const boardViews = new Map();
const sheet = byId("sheet");
const body = byId("sheet-body");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const localization = window.taskboardLocalization;
const t = (key, parameters) => localization.text(key, parameters);
let appUpdate;
let renderedUpdateNotes;
const updateDialog = byId("update-dialog");
const updateMarkdown = window.markdownit?.({ html: false }).disable("image");
if (updateMarkdown) {
  updateMarkdown.renderer.rules.link_open = () => "";
  updateMarkdown.renderer.rules.link_close = () => "";
}

function renderAppUpdate() {
  const available = appUpdate?.available;
  const candidate = appUpdate?.candidate;
  byId("app-update-badge").hidden = !available;
  controlLabelForIcon(byId("app-settings"), () => {
    const settings = t("ui.settings_and_updates_f9f74584");
    return available ? settings + ". " + t("updates.available_version", { version: available.version }) : settings;
  });
  syncSettingsUpdateItems();
  if (!candidate) {
    if (updateDialog.open) {
      updateDialog.close();
      byId("app-settings").focus();
    }
    return;
  }
  if (!updateDialog.open) return;

  byId("update-title").textContent = t("updates.available_version", { version: candidate.version });
  const notes = byId("update-notes");
  const source = candidate.notes || t("updates.no_notes");
  if (source !== renderedUpdateNotes) {
    renderedUpdateNotes = source;
    if (candidate.notes && updateMarkdown) {
      notes.innerHTML = updateMarkdown.render(source);
    } else {
      notes.textContent = source;
    }
    notes.scrollTop = 0;
  }

  const { phase, supported, progress, error, installing } = appUpdate;
  const downloading = phase === "downloading";
  const ready = phase === "ready";
  const discarding = phase === "discarding";
  const cleanupFailed = phase === "cleanup-error";
  const status = byId("update-status");
  let message = "";
  if (downloading) {
    message = t("updates.downloading");
  } else if (discarding) {
    message = t("updates.cleaning");
  } else if (cleanupFailed) {
    message = t("updates.cleanup_failed", { reason: error });
  } else if (phase === "installing") {
    message = t("updates.preparing");
  } else if (error) {
    const reason = error === "UPDATE_APP_BUSY" ? t("updates.busy")
      : error === "UPDATE_CANCELLED" ? t("updates.cancelled") : error;
    message = t("updates.failed", { reason });
  } else if (ready) {
    message = t("updates.verified");
  }
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !message;
  const meter = byId("update-progress");
  meter.hidden = !downloading;
  byId("update-progress-display").hidden = !downloading;
  const track = byId("update-progress-track");
  track.classList.toggle("indeterminate", downloading && !progress?.total);
  if (progress?.total) {
    meter.max = progress.total;
    meter.value = progress.received;
  } else {
    meter.removeAttribute("value");
  }
  track.style.setProperty("--update-progress", String(Math.max(0, meter.position)));
  const percent = byId("update-progress-percent");
  percent.hidden = !downloading || meter.position < 0;
  if (!percent.hidden) {
    percent.textContent = new Intl.NumberFormat(localization.locale, { style: "percent" })
      .format(Math.floor(meter.value * 100 / meter.max) / 100);
  }

  const release = byId("update-release");
  release.href = candidate.url;
  release.textContent = t("ui.open_release_b1c993b5");
  const later = byId("update-later");
  later.disabled = discarding;
  later.textContent = t(ready || discarding || cleanupFailed ? "updates.later" : "updates.close");
  const action = byId("update-action");
  action.hidden = !supported || downloading || discarding || cleanupFailed || phase === "installing";
  action.disabled = installing;
  action.textContent = t(ready ? "updates.restart" : error ? "updates.retry" : "updates.download");
}

function openUpdateDialog() {
  if (!appUpdate?.candidate || updateDialog.open) return;
  byId("update-title").textContent = t("updates.available_version", { version: appUpdate.candidate.version });
  updateDialog.showModal();
  renderAppUpdate();
}

const localizedBindings = new Set();
const nodeBindings = new WeakMap();
function bindLocalized(node, property, render, attribute = false) {
  const bindings = nodeBindings.get(node) ?? new Map();
  nodeBindings.set(node, bindings);
  const key = (attribute ? "@" : "") + property;
  const previous = bindings.get(key);
  if (previous) localizedBindings.delete(previous);
  const value = String(render());
  let target = node;
  if (property === "textContent" && !attribute) {
    node.textContent = value;
    target = node.firstChild ?? node.appendChild(document.createTextNode(""));
  } else if (attribute) node.setAttribute(property, value); else node[property] = value;
  const binding = { node, target, property, render, attribute, value };
  bindings.set(key, binding);
  localizedBindings.add(binding);
  return value;
}
function refreshLocalizedBindings() {
  for (const binding of localizedBindings) {
    const { node, target, property, render, attribute } = binding;
    if (!node.isConnected || !target.isConnected) { localizedBindings.delete(binding); continue; }
    const current = target !== node ? target.textContent : attribute ? node.getAttribute(property) : node[property];
    if (current !== binding.value) { localizedBindings.delete(binding); continue; }
    const value = String(render());
    if (target !== node) target.textContent = value; else if (attribute) node.setAttribute(property, value); else node[property] = value;
    binding.value = value;
  }
}
const lanes = [
  ["draft", "ui.draft_c685cd08"], ["ready", "ui.ready_83de5408"],
  ["in_progress", "ui.in_progress_59da65c9"], ["blocked", "ui.blocked_bd8f5170"],
  ["review", "ui.in_review_65e2fab2"], ["done", "ui.done_8167d158"],
  ["cancelled", "ui.cancelled_0ec9befc"],
];

function localizedOption(label, value) {
  const option = element("option", label);
  option.value = value;
  return option;
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (typeof text === "function") bindLocalized(item, "textContent", text);
  else if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function icon(name) {
  const aliases = {
    images: "files", thought: "lightbulb", tool: "tools", board: "layout",
    plus: "add", chevron: "chevron-up", dependency: "link", attachment: "attach",
    stop: "debug-stop", microphone: "mic", "git-user": "account", notifications: "bell", "git-tag": "tag", chat: "comment-discussion",
  };
  const item = element("i", undefined, "icon codicon codicon-" + (aliases[name] ?? name));
  item.setAttribute("aria-hidden", "true");
  return item;
}

let displayedBoardError;
const dismissedBoardErrors = new Map();

function windowNotice(message, context, boardErrorKey) {
  displayedBoardError = boardErrorKey;
  byId("notice-context").textContent = context ?? "";
  byId("notice-message").textContent = message ?? "";
  byId("notice").hidden = !message;
  controlLabelForIcon(byId("notice-close"), () => t("ui.dismiss_notification_9a17797e"));
}

function notice(message, context) {
  if (!sheet.open) {
    if (message || !displayedBoardError) windowNotice(message, context ?? "AI Taskboard");
    return;
  }
  const target = byId("sheet-notice");
  target.textContent = message || "";
  target.hidden = !message;
}

function syncBoardNotice(projectChanged) {
  const { project, error, tabs } = frame;
  if (Array.isArray(tabs)) {
    for (const path of dismissedBoardErrors.keys()) {
      if (path !== project && !tabs.some(tab => tab.path === path)) dismissedBoardErrors.delete(path);
    }
  }
  if (!error) {
    dismissedBoardErrors.delete(project);
    if (projectChanged || displayedBoardError) windowNotice();
    return;
  }
  const key = JSON.stringify([project, error.operation, error.code, error.message, frame.localization?.locale]);
  if (key === displayedBoardError) return;
  if (key === dismissedBoardErrors.get(project)) {
    if (projectChanged || displayedBoardError) windowNotice();
    return;
  }
  dismissedBoardErrors.delete(project);
  const operations = {
    refresh: t("ui.board_refresh_4c949d36"),
    open: t("ui.opening_project_bc49a4b5"),
    create: t("ui.creating_board_b832d368"),
    "save-session": t("ui.saving_tabs_30c5a2ed"),
  };
  const operation = operations[error.operation] ?? t("ui.project_4bc2b2f8");
  const message = error.operation === "refresh" && error.code === "BOARD_BUSY"
    ? t("ui.the_board_is_busy_updates_will_retry_automatical_235bb58a")
    : boardError(error);
  windowNotice(message, [operation, projectName()].filter(Boolean).join(" · "), key);
}

function projectName() {
  return frame.tabs?.find(tab => tab.path === frame.project)?.name ?? frame.project?.split(/[\\/]/).at(-1);
}

function boardError(error) {
  if (error.code === "TASK_AWAITING_ANSWER") {
    return t("task_question.approval_blocked");
  }
  if (error.code === "BOARD_BUSY") {
    return t("ui.the_board_is_busy_with_another_operation_try_aga_e9c8de78");
  }
  if (error.code === "ARTIFACT_LIMIT") {
    return t("ui.this_task_can_keep_up_to_64_mib_and_64_artifact__5d7c7c7a");
  }
  if (error.code === "ARTIFACT_DIRECTORY") {
    return [t("ui.select_individual_files_needed_for_review_71f19acd"),
      error.details?.path].filter(Boolean).join("\n");
  }
  if (error.code === "ARTIFACT_UNAVAILABLE") {
    return t("ui.this_review_file_is_no_longer_available_cce7f583");
  }
  const gitMessages = {
    STALE_REPOSITORY: t("ui.the_branch_changed_retry_with_its_current_revisi_f09480d6"),
    GIT_WORKTREE_REQUIRED: t("ui.open_a_repository_with_a_main_worktree_31b281c4"),
    WORKING_DIRECTORY_UNAVAILABLE: t("ui.the_selected_working_directory_is_unavailable_or_43dc81fb"),
    GIT_COMMIT_REQUIRED: t("ui.select_a_branch_with_a_commit_first_6f14dd57"),
    REMOTE_EXISTS: localization.errorText(error.message),
    GITHUB_UNAVAILABLE: t("ui.install_github_cli_gh_and_sign_in_with_gh_auth_l_a1832f3d"),
    GITHUB_CLI_MISSING: t("ui.install_github_cli_gh_on_the_host_and_make_it_av_af2f59c3"),
    GITHUB_AUTH_REQUIRED: t("ui.github_cli_has_no_usable_login_in_the_host_profi_6912b192"),
    GITHUB_AUTH_STORAGE: t("ui.github_cli_cannot_access_the_saved_credential_in_3651b110"),
    GITHUB_AUTH_OVERRIDE: t("ui.github_rejected_the_credential_supplied_by_gh_to_45e56c03"),
    GITHUB_AUTH_REJECTED: t("ui.github_rejected_the_host_credential_check_whethe_bb325ce4"),
    GITHUB_AUTH_SCOPE: t("ui.check_the_credential_permissions_and_your_github_6cf04c8e"),
    GITHUB_RESOURCE_ACCESS: t("ui.check_that_the_resource_exists_and_the_current_g_453062ba"),
    GITHUB_RATE_LIMIT: t("ui.github_s_api_rate_limit_was_reached_retry_after__38f6e72a"),
    GITHUB_REMOTE_REQUIRED: t("ui.use_a_milestone_from_the_github_repository_confi_3adf5b21"),
    GITHUB_MILESTONES_FAILED: t("ui.could_not_load_github_milestones_check_your_conn_1a4e6e9b"),
    GITHUB_PUBLISH_FAILED: t("ui.github_publication_failed_check_your_connection__39a77538"),
    GITHUB_PUSH_FAILED: t("ui.the_repository_and_origin_were_created_but_the_p_c2c2798f"),
  };
  if (gitMessages[error.code]) return [gitMessages[error.code], error.details?.output].filter(Boolean).join("\n");
  if (error.code === "DEPENDENCIES_INCOMPLETE") {
    return t("ui.complete_the_dependencies_first_4d0beead") + " " +
      (error.details?.dependencies ?? []).join(", ");
  }
  if (error.code === "DEPENDENCY_CYCLE") {
    return t("ui.a_task_cannot_depend_on_itself_directly_or_indir_f6bc7702");
  }
  if (error.code === "BOARD_NOT_FOUND") {
    return t("ui.no_board_in_the_selected_folder_choose_another_f_53c0ae51");
  }
  if (error.code === "GIT_UNAVAILABLE") {
    return t("ui.install_git_2_38_or_newer_then_reopen_the_projec_8924b3d7");
  }
  const { output, path, paths } = error.details ?? {};
  const files = Array.isArray(paths) ? paths.join("\n") : undefined;
  const message = error.code === "MERGE_CONFLICT"
    ? t("ui.the_task_conflicts_with_the_target_branch_ask_th_85368e7a")
    : error.code === "LOCAL_CHANGES_CONFLICT"
    ? t("ui.the_task_conflicts_with_local_changes_the_target_612b0994")
    : error.code === "WORKTREE_ACCESS_DENIED"
    ? t("ui.close_programs_using_the_worktree_or_restore_acc_487507a0")
    : error.code === "RESTORE_CONFLICT"
    ? t("ui.could_not_restore_the_changes_the_backup_is_stil_d85fbca1")
    : localization.errorText(error.message);
  return [message, path, files, output].filter(value => typeof value === "string" && value.length)
    .join("\n").slice(0, 4000);
}

function protect(callback) {
  return (...args) => { Promise.resolve().then(() => callback(...args)).catch(error => notice(error.message)); };
}

function button(label, click, kind = "") {
  const item = element("button", label, ("button " + kind).trim());
  item.type = "button";
  item.addEventListener("click", protect(click));
  return item;
}

async function checkUpdates() {
  openSheet("updates", () => t("ui.ai_taskboard_updates_85f012a2"));
  const status = element("p", () => t("ui.checking_for_updates_9b7efe11"));
  status.setAttribute("role", "status");
  const retry = button(() => t("ui.check_again_8ea75e16"), run);
  retry.id = "updates-retry";
  const content = element("section", undefined, "sheet-section");
  content.id = "updates-result";
  body.append(status, content, retry);
  async function run() {
    retry.disabled = true;
    content.replaceChildren();
    bindLocalized(status, "textContent", () => t("ui.checking_for_updates_9b7efe11"));
    try {
      const result = await api.checkUpdates();
      if (!content.isConnected) return;
      if (!result.ok) throw new Error(result.error.message);
      const { currentVersion, sourceUrl, status: outcome, latest } = result.data;
      content.append(element("p", () => t("ui.installed_version_398296ba") + currentVersion));
      bindLocalized(status, "textContent", () => outcome === "available"
        ? t("ui.a_new_version_is_available_770c4531") + latest.version +
          (latest.prerelease ? t("ui.prerelease_57729e95") : "")
        : outcome === "empty" ? t("ui.no_releases_are_published_for_this_update_channe_ccc2396d")
          : t("ui.you_have_the_latest_version_of_ai_taskboard_cdd42ce1"));
      if (outcome === "available") {
        const release = button(() => t("ui.open_release_b1c993b5"), () => api.openLink(latest.url), "primary");
        release.id = "updates-open-release";
        content.append(release, element("p", () => t("ui.choose_a_download_for_your_system_on_the_release_7b98ee8e"), "muted"));
      }
      content.append(button(() => t("ui.all_releases_b5b6002c"), () => api.openLink(sourceUrl), "quiet"));
    } catch {
      if (!content.isConnected) return;
      bindLocalized(status, "textContent", () => t("ui.could_not_check_for_updates_check_your_connectio_dde887d1"));
    } finally {
      if (retry.isConnected) retry.disabled = false;
    }
  }
  await run();
}

async function projectStatistics() {
  if (!frame.board) return;
  openSheet("statistics", () => t("ui.project_statistics_e6a29f59"));
  const generation = projectGeneration;
  const content = element("section", undefined, "sheet-section");
  content.id = "project-statistics";
  const status = element("p");
  status.setAttribute("role", "status");
  const retry = button(() => t("ui.retry_553b2066"), run);
  let timer;
  let loading = false;
  const current = () => generation === projectGeneration && sheet.open && content.isConnected;
  const stop = () => { clearTimeout(timer); sheet.removeEventListener("close", stop); };
  sheet.addEventListener("close", stop);
  body.append(element("p", projectName()), element("p", () => t("ui.all_available_project_records_including_closed_a_cae4b7bc"), "muted"), status, content, retry);
  const fields = [
    ["totalTokens", "ui.total_3398e3ff"], ["inputTokens", "ui.input_5a192b55"],
    ["outputTokens", "ui.output_44d9862a"], ["cachedInputTokens", "ui.cache_read_69f0ff95"],
    ["cacheWriteInputTokens", "ui.cache_write_25ddf881"], ["reasoningOutputTokens", "ui.reasoning"],
  ];
  const counts = (target, entry) => {
    const list = element("dl", undefined, "statistics-counts");
    for (const [key, labelKey] of fields) {
      const value = entry[key];
      list.append(element("dt", () => t(labelKey)), element("dd", () => value == null
        ? t("ui.no_data_24fdb418") : value.toLocaleString(localization.locale)));
    }
    target.append(list);
    if (entry.incomplete) target.append(element("p", () => t("ui.partial_records_known_tokens_only_0f5f6f9d"), "muted"));
  };
  async function run() {
    if (!current() || loading) return;
    clearTimeout(timer);
    loading = true;
    retry.disabled = true;
    bindLocalized(status, "textContent", () => t("ui.loading_2ad65fd8"));
    try {
      const result = await api.command("project-usage");
      if (!current()) return;
      if (!result.ok) throw result.error;
      const data = result.data;
      content.replaceChildren();
      bindLocalized(status, "textContent", () => data.total === null ? t("ui.no_token_data_acff9652")
        : data.incomplete ? t("ui.partial_accounting_3e4cdf56") : t("ui.recorded_usage_02e49032"));
      content.append(element("h3", () => t("ui.known_total_ba291063")), element("p", () => data.total === null
        ? t("ui.no_data_24fdb418") : data.total.toLocaleString(localization.locale)));
      content.append(element("p", () => t("ui.tasks_without_reports_1310f4b1") + data.missingTasks + " / " + data.tasks));
      content.append(element("p", () => t("ui.manager_reports_ee9f6438") + data.managerReports));
      content.append(element("p", () => t("ui.usage_before_telemetry_or_outside_the_board_is_u_2cc6c15c"), "muted"));
      for (const [title, models] of [[t("ui.by_model_e992eced"), data.byModel],
        ...Object.entries(data.byRole).map(([role, models]) => [{ manager: t("ui.manager_92a95b5c"),
          executor: t("ui.executors_66276668"), reviewer: t("ui.reviewers_fd4fe839"),
          discussion: t("ui.task_discussions_6e9601cc"), unattributed: t("ui.unattributed_role_4cbf5f24") }[role], models])]) {
        const group = element("section", undefined, "sheet-section");
        group.append(element("h3", title));
        if (!models.length) group.append(element("p", () => t("ui.no_data_24fdb418")));
        for (const model of models) {
          group.append(element("h4", () => model.model ?? t("ui.unknown_model_a335af5d")));
          counts(group, model);
        }
        content.append(group);
      }
      retry.hidden = true;
    } catch (error) {
      if (!current()) return;
      content.replaceChildren();
      bindLocalized(status, "textContent", () => t("ui.could_not_load_statistics_f6605b49") + boardError(error));
      retry.hidden = false;
    } finally {
      loading = false;
      if (current()) {
        retry.disabled = false;
        timer = setTimeout(run, 5000);
      } else stop();
    }
  }
  await run();
}

function positionSettingsMenu() {
  const menu = byId("settings-menu");
  const anchor = byId("app-settings").getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(anchor.right, innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(anchor.bottom - menu.offsetHeight, innerHeight - menu.offsetHeight - 4)) + "px";
}

function syncSettingsUpdateItems() {
  const update = byId("settings-menu-update");
  const check = byId("settings-menu-updates");
  if (!update || !check) return;
  const focused = document.activeElement;
  const showUpdate = Boolean(appUpdate?.candidate);
  const showCheck = !appUpdate?.available;
  if (update.hidden === !showUpdate && check.hidden === !showCheck) return;
  update.hidden = !showUpdate;
  check.hidden = !showCheck;
  if (!byId("settings-menu").matches(":popover-open")) return;
  positionSettingsMenu();
  if (focused === update && update.hidden) check.focus();
  if (focused === check && check.hidden) update.focus();
}

function openSettingsMenu(last = false) {
  const trigger = byId("app-settings");
  const menu = byId("settings-menu");
  if (menu.matches(":popover-open")) {
    menu.hidePopover();
    return;
  }
  const app = button(() => t("ui.ai_taskboard_settings_35895923"), () => {
    menu.hidePopover();
    trigger.focus();
    settings();
  });
  const board = button(() => t("ui.board_settings_063b85d6"), () => {
    menu.hidePopover();
    trigger.focus();
    boardSettings();
  });
  board.disabled = !frame.board;
  const statistics = button(() => t("ui.statistics_68cdd4da"), () => {
    menu.hidePopover();
    trigger.focus();
    return projectStatistics();
  });
  statistics.disabled = !frame.board;
  const backups = button(() => t("backup.title"), () => {
    menu.hidePopover();
    trigger.focus();
    return backupSettings();
  });
  const update = button(() => t("updates.download"), () => {
    menu.hidePopover();
    trigger.focus();
    openUpdateDialog();
  });
  const check = button(() => t("ui.check_for_updates_6a5aded8"), () => {
    menu.hidePopover();
    trigger.focus();
    return checkUpdates();
  });
  for (const [id, item] of [
    ["app", app],
    ["board", board],
    ["backups", backups],
    ["statistics", statistics],
    ["update", update],
    ["updates", check],
  ]) {
    item.className = "app-menu-item";
    item.id = "settings-menu-" + id;
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-disabled", String(item.disabled));
    item.tabIndex = -1;
  }
  const separator = element("hr");
  separator.setAttribute("role", "separator");
  bindLocalized(menu, "aria-label", () => t("ui.settings_and_updates_f9f74584"), true);
  menu.replaceChildren(app, board, backups, statistics, separator, update, check);
  syncSettingsUpdateItems();
  menu.showPopover({ source: trigger });
  positionSettingsMenu();
  (last ? (check.hidden ? update : check) : app).focus();
}

function mountAppMenu() {
  const bar = byId("app-menu");
  bindLocalized(bar, "aria-label", () => t("ui.application_menu_8ee321c8"), true);
  const groups = [
    ["ui.file_e2d36042", [
      ["new-window", "ui.new_window_894742fe", "N"],
      ["create-project", "ui.create_project_a0290705"],
      ["open-project", "ui.open_project_9b4df4b2", "O"],
      ["open-recent", "ui.open_recent_6bef1497"],
      ["close-tab", "ui.close_project_8492d519", "W"],
      ["close-window", "ui.close_window_5cc3b3ba", "Shift+W"],
      ["settings", "ui.application_settings_908d8b4c", ","],
      ["board-settings", "ui.board_settings_063b85d6"],
      ["quit", "ui.exit_522b8be3"],
    ]],
    ["ui.edit_876a287f", [
      ["undo", "ui.undo_70374434", "Z"],
      ["redo", "ui.redo_616c79e6", api.isMac ? "Shift+Z" : "Y"],
      ["cut", "ui.cut_faf6b87a", "X"],
      ["copy", "ui.copy_47162712", "C"],
      ["paste", "ui.paste_e9f43536", "V"],
      ["select-all", "ui.select_all_ab174554", "A"],
    ]],
    ["ui.view_5fade440", [
      ["archive-view", "ui.archive_d036e225"],
      ["zoom-in", "ui.zoom_in_ee912b88", "+"],
      ["zoom-out", "ui.zoom_out_f212b60f", "-"],
      ["reset-zoom", "ui.reset_zoom_2b15b05e", "0"],
      ["fullscreen", "ui.full_screen_dcbaed24", "F11"],
    ]],
    ["ui.help_a6529046", [
      ["about", "ui.about_ai_taskboard_da4829d7"],
    ]],
  ];
  const shortcuts = new Map();
  let active;
  let previousFocus;
  let recentMenu;

  function close() {
    if (!active) return;
    if (recentMenu) { recentMenu.popup.hidden = true; recentMenu.trigger.setAttribute("aria-expanded", "false"); }
    active.popup.hidden = true;
    active.trigger.setAttribute("aria-expanded", "false");
    active = undefined;
  }

  function open(menu, index = 0) {
    close();
    active = menu;
    menu.popup.hidden = false;
    menu.trigger.setAttribute("aria-expanded", "true");
    menu.items.at(index).focus();
  }

  const run = protect(action => {
    if (action === "open-recent") {
      const popup = recentMenu.popup;
      popup.replaceChildren();
      for (const recent of frame.recentBoards ?? []) {
        const item = button("", () => {
          close();
          return api.openRecent(recent.path);
        });
        item.className = "app-menu-item";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        item.append(element("span", recent.name), element("small", recent.path));
        popup.append(item);
      }
      if (!popup.childElementCount) {
        const empty = button(() => t("ui.no_recent_projects_8b05ba12"), () => {});
        empty.className = "app-menu-item";
        empty.setAttribute("role", "menuitem");
        empty.setAttribute("aria-disabled", "true");
        popup.append(empty);
      }
      popup.hidden = false;
      recentMenu.trigger.setAttribute("aria-expanded", "true");
      popup.firstElementChild.focus();
      return;
    }
    if (action === "archive-view" && !frame.board) return;
    if (active) {
      const trigger = active.trigger;
      close();
      (previousFocus?.isConnected ? previousFocus : trigger).focus();
    }
    if (action === "archive-view") {
      archiveView = !archiveView;
      byId("filters").open = false;
      render();
      return;
    }
    if (action === "settings") return settings();
    if (action === "board-settings") return boardSettings();
    if (action === "create-project") return createBoard();
    return api.menuAction(action);
  });

  const menus = groups.map(([labelKey, commands], index) => {
    const group = element("div", undefined, "app-menu-group");
    group.setAttribute("role", "none");
    const label = t(labelKey);
    const trigger = element("button", () => t(labelKey), "app-menu-trigger");
    trigger.type = "button";
    trigger.tabIndex = index === 0 ? 0 : -1;
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const popup = element("div", undefined, "app-menu-popup");
    popup.hidden = true;
    popup.setAttribute("role", "menu");
    bindLocalized(popup, "aria-label", () => t(labelKey), true);
    const items = commands.map(([action, labelKey, shortcut]) => {
      const item = button("", () => run(action));
      item.className = "app-menu-item";
      item.tabIndex = -1;
      item.setAttribute("role", action === "archive-view" ? "menuitemcheckbox" : "menuitem");
      if (action === "archive-view") item.id = "archive-menu-item";
      if (action === "board-settings") item.id = "board-settings-menu-item";
      if (action === "settings") item.id = "app-settings-menu-item";
      item.append(element("span", () => t(labelKey)));
      if (shortcut) {
        shortcuts.set(shortcut, action);
        const prefix = shortcut === "F11" ? "" : api.isMac ? "⌘" : "Ctrl+";
        item.append(element("kbd", prefix + shortcut));
      }
      if (action === "open-recent") {
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        item.append(element("span", "›"));
        const container = element("div", undefined, "app-menu-submenu-trigger");
        const submenu = element("div", undefined, "app-menu-popup app-menu-submenu");
        submenu.hidden = true;
        submenu.setAttribute("role", "menu");
        bindLocalized(submenu, "aria-label", () => t(labelKey), true);
        container.append(item, submenu);
        popup.append(container);
        recentMenu = { trigger: item, popup: submenu };
      } else popup.append(item);
      return item;
    });
    const menu = { group, trigger, popup, items };
    trigger.addEventListener("click", () => {
      if (active === menu) close();
      else open(menu);
    });
    group.append(trigger, popup);
    bar.append(group);
    return menu;
  });

  document.addEventListener("pointerdown", event => {
    if (!bar.contains(event.target)) close();
  });
  document.addEventListener("focusin", event => {
    if (!bar.contains(event.target)) {
      close();
      previousFocus = event.target;
      return;
    }
    const focused = menus.find(menu => menu.group.contains(event.target));
    for (const menu of menus) menu.trigger.tabIndex = menu === focused ? 0 : -1;
  });
  bar.addEventListener("keydown", event => {
    if (recentMenu && !recentMenu.popup.hidden && recentMenu.popup.contains(event.target)) {
      const items = [...recentMenu.popup.children];
      if (["Escape", "ArrowLeft"].includes(event.key)) {
        recentMenu.popup.hidden = true;
        recentMenu.trigger.setAttribute("aria-expanded", "false");
        recentMenu.trigger.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const index = items.indexOf(event.target);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      } else if (event.key !== "Tab") return;
      else close();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target === recentMenu?.trigger && event.key === "ArrowRight") {
      event.preventDefault();
      run("open-recent");
      return;
    }
    const index = menus.findIndex(menu => menu.group.contains(event.target));
    const menu = menus[index];
    if (!menu) return;
    if (event.key === "Escape" || event.key === "Tab") {
      if (!active) return;
      close();
      menu.trigger.focus();
      if (event.key === "Tab") return;
      event.stopPropagation();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const next = menus[(index + offset + menus.length) % menus.length];
      if (active) open(next);
      else next.trigger.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const itemIndex = menu.items.indexOf(event.target);
      if (itemIndex < 0) open(menu, offset === 1 ? 0 : -1);
      else menu.items[(itemIndex + offset + menu.items.length) % menu.items.length].focus();
    } else if (active && (event.key === "Home" || event.key === "End")) {
      menu.items.at(event.key === "Home" ? 0 : -1).focus();
    } else return;
    event.preventDefault();
  });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.altKey || event.isComposing) return;
    if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      bar.querySelector('.app-menu-trigger[tabindex="0"]').focus();
      return;
    }
    const modifier = api.isMac ? event.metaKey : event.ctrlKey;
    if (!modifier && event.key !== "F11") return;
    const key = event.code.startsWith("Key") ? event.code.slice(3) : event.key;
    if (event.shiftKey && key !== "Z" && key !== "W" && key !== "+") return;
    const shortcut = key === "=" ? "+" : event.shiftKey && ["Z", "W"].includes(key) ? "Shift+" + key : key;
    const action = !api.isMac && shortcut === "Shift+Z" ? "redo" : shortcuts.get(shortcut);
    if (!action) return;
    // Chromium handles these shortcuts against the current selection on Windows.
    if (api.isWindows && !active && (action === "copy" || action === "paste")) return;
    event.preventDefault();
    if (!event.repeat) run(action);
  });
  bar.hidden = false;
}

async function command(action, id, input) {
  const generation = projectGeneration;
  const project = frame.project;
  const result = await api.command(action, id, input);
  if (action === "expert-save" && result.ok) taskExpertCatalog.delete(project);
  if (generation !== projectGeneration) return undefined;
  if (!result.ok) {
    if (result.error.code === "ACTIVE_GOAL_REQUIRED") {
      notice(t("autoMode.goalRequired"));
      return undefined;
    }
    if (result.error.code === "ACCEPTANCE_CANCELLED") return undefined;
    const actions = {
      update: ["ui.editing_task_56c9ac84"], approve: ["ui.approving_task_68f23ece"],
      "return-to-draft": ["ui.returning_task_to_draft_a416bf7a"],
      "attachment-cover": ["ui.changing_task_cover_1c1995c0"],
      comment: ["ui.adding_comment_a8a9a57d"], cancel: ["ui.cancelling_task_7b10c43e"],
      "request-changes": ["ui.requesting_changes_936d81b8"], review: ["ui.reviewing_task_2b6829f2"],
      accept: ["ui.accepting_task_39473c27"], "cleanup-status": ["ui.checking_worktree_cleanup_1f82f9a8"],
      "restore-changes": ["ui.restoring_changes_b62b21aa"], settings: ["ui.saving_board_settings_0fce259e"],
      "tag-create": ["ui.creating_tag_33a8fd23"], "tag-color": ["ui.changing_tag_color_d8c15c8d"],
      "tag-assign": ["ui.editing_tags_adce1553"],
      milestones: ["ui.loading_github_milestones_17f08928"], milestone: ["ui.changing_github_milestone_81cd8f77"],
    };
    const label = actions[action] ?? ["ui.board_action_979b13d5"];
    notice(boardError(result.error), [t(...label), id, projectName()].filter(Boolean).join(" · "));
    return undefined;
  }
  notice();
  return result.data;
}

function openSheet(kind, title) {
  if (kind !== "task") taskSheetRequest++;
  chatPreviews.disconnect();
  sheetKind = kind;
  sheet.classList.toggle("task-sheet", kind === "task");
  byId("task-side").hidden = true;
  byId("task-side").replaceChildren();
  if (typeof title === "function") bindLocalized(byId("sheet-title"), "textContent", title);
  else byId("sheet-title").textContent = title;
  body.replaceChildren();
  byId("sheet-notice").hidden = true;
  if (!sheet.open) {
    const branches = byId("git-branches");
    if (branches.matches(":popover-open")) branches.hidePopover();
    focusBeforeSheet = document.activeElement;
    sheet.show();
    byId("app-content").inert = true;
    document.querySelector(".status-bar").inert = true;
  }
  if (!sheet.contains(document.activeElement)) {
    byId("close-sheet").focus();
  }
}

function section(title, content, target = body) {
  if (content === undefined || content === "" || (Array.isArray(content) && !content.length)) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", title));
  if (Array.isArray(content)) {
    const list = element("ul");
    for (const value of content) {
      const item = element("li");
      item.append(value instanceof Node ? value : chatText(value));
      list.append(item);
    }
    area.append(list);
  } else area.append(chatText(content));
  target.append(area);
}

function removeLegacyTaskHeadings(content) {
  for (const heading of content.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")) {
    if (/^(?:проблема|ожидаемый результат|ограничения|problem|expected result|constraints)$/iu.test(heading.textContent.trim())) heading.remove();
  }
}

function taskDescription(text, taskId) {
  if (!text) return;
  const area = element("section", undefined, "sheet-section task-sheet-description");
  const content = chatText(text, { taskId });
  for (const heading of content.querySelectorAll(":scope > :is(h1, h2, h3, h4, h5, h6)")) {
    if (heading.parentElement !== content || heading.textContent.trim() !== "Диагностика и связанные файлы") continue;
    const level = Number(heading.tagName[1]);
    while (heading.nextElementSibling) {
      const next = heading.nextElementSibling;
      if (/^H[1-6]$/.test(next.tagName) && Number(next.tagName[1]) <= level) break;
      next.remove();
    }
    heading.remove();
  }
  removeLegacyTaskHeadings(content);
  area.append(element("h3", () => t("ui.description_b4571c10")), content);
  body.append(area);
}

function cardDescription(text) {
  if (!chatMarkdown) return element("span", text, "task-description");
  // A template stays inert: no links, images or controls enter the card button.
  const template = document.createElement("template");
  template.innerHTML = "<div>" + chatMarkdown.render(text) + "</div>";
  const content = template.content.firstElementChild;
  removeLegacyTaskHeadings(content);
  for (const image of content.querySelectorAll("img")) image.replaceWith(image.alt);
  return element("span", content.textContent.trim(), "task-description");
}

function checkCommandLabel(command) {
  if (/\btools[\\/]wiki[\\/]/i.test(command)) {
    return /test_generate\.py/i.test(command) ? t("ui.documentation_generator_tests_9fae4396") :
      t("ui.generated_documentation_c18e33f9");
  }
  if (/\btools[\\/]coverage[\\/]/i.test(command)) return t("ui.api_coverage_d85adcbd");
  if (/^dotnet build\b/i.test(command)) {
    const configuration = command.match(/\s(?:-c|--configuration)\s+([\w.-]+)/i)?.[1];
    return t("ui.build_1daac2f0") + (configuration ? " · " + configuration : "");
  }
  if (/^dotnet format\b/i.test(command)) {
    const project = command.match(/(?:^|[\s"'\\/])([^\s"'\\/]+)\.csproj\b/i)?.[1];
    return t("ui.code_formatting_5fd234f0") + (project ? " · " + project : "");
  }
  if (/^git diff --check\b/i.test(command)) return /;\s*rg\b/i.test(command) ?
    t("ui.diff_and_text_search_b3bbedcc") : t("ui.diff_whitespace_805b5a39");
  const script = command.match(/(?:^|[\s\\/])([\w.-]+)\.(?:ps1|py|sh)\b/i)?.[1];
  if (script?.startsWith("test_")) return t("ui.tests_f896b694") + " · " + script.slice(5).replaceAll("_", " ");
  const suite = command.match(/\$env:\w+\s*=\s*["']([^"']+)["']/gi);
  if (suite?.length && /\bdotnet\b/i.test(command)) {
    const variants = suite.map(value => value.match(/["']([^"']+)["']/)[1]).filter(value => !/[\\/]/.test(value));
    return t("ui.test_run_9f510f80") + (variants.length ? " · " + variants.join(" / ") : "");
  }
  if (/^dotnet test\b/i.test(command)) return t("ui.net_tests_238a6d60");
  if (script) return t("ui.script_83c4a42b") + " · " + script.replaceAll("_", " ");
  if (/^(?:\$env:|& |dotnet |git |rg |npm |node |python[3]? |pwsh |powershell |bash |cargo |pytest\b|\.\.?[\\/])/i.test(command)) {
    return t("ui.command_e66f2e58") + " · " + command.split(/\s+/, 2).join(" ").slice(0, 48);
  }
}

function showSubmissionResult(result, target = body) {
  if (!result) return;
  section(() => (t("ui.result_817dc3f4")), result.summary, target);
  if (result.checks?.length) {
    const area = element("section", undefined, "sheet-section task-checks");
    area.append(element("h3", () => t("ui.checks_33b2cadc")));
    const totals = { passed: 0, failed: 0, skipped: 0 };
    for (const value of result.checks) {
      const parts = value.match(/^([\s\S]+?)\n(?:Command|Команда):\s*([\s\S]+)$/i);
      const statement = (parts?.[1] ?? value).trim();
      const outcome = statement.match(/^([\s\S]+?)(?:\s+[-–—]\s+|:\s*)(pass(?:ed)?|fail(?:ed)?|skipped|not run|пройден[аоы]?|не пройден[аоы]?|пропущен[аоы]?|не запускал[аи]?)(?:[\s,;:.—–-]+([\s\S]*))?$/i);
      const name = outcome?.[1] ?? statement;
      const commandLabel = !parts && outcome ? checkCommandLabel(name) : undefined;
      const status = outcome?.[2].toLowerCase();
      const passed = status && /^(?:pass|пройден)/.test(status);
      const failed = status && /^(?:fail|не пройден)/.test(status);
      const command = parts?.[2] ?? (commandLabel && value);
      const note = outcome?.[3];
      const expandedDetails = command || note?.length > 110;
      const row = element(expandedDetails ? "details" : "div", undefined, "task-check");
      const line = element(expandedDetails ? "summary" : "div", undefined, "task-check-line");
      if (expandedDetails) {
        const arrow = element("i", undefined, "codicon codicon-chevron-right task-check-arrow");
        arrow.setAttribute("aria-hidden", "true");
        line.append(arrow);
      }
      const copy = element("span", undefined, "task-check-copy");
      copy.append(command || outcome ? element("span", commandLabel ?? name, "task-check-name") : chatText(name));
      if (note && !expandedDetails) copy.append(element("span", note, "task-check-note"));
      line.append(copy);
      if (status) {
        const label = passed ? t("ui.passed_68bec83e") : failed ? t("ui.failed_5f8945bd") : t("ui.skipped_8c40ee29");
        const badge = element("span", label, "task-check-status");
        badge.dataset.outcome = passed ? "passed" : failed ? "failed" : "skipped";
        totals[badge.dataset.outcome]++;
        line.append(badge);
      }
      row.append(line);
      if (note && expandedDetails) row.append(element("p", note, "task-check-detail"));
      if (command) row.append(element("pre", command, "task-check-command"));
      area.append(row);
    }
    const counts = element("p", undefined, "task-check-counts");
    for (const [outcome, label] of [["passed", "ui.passed_68bec83e"], ["failed", "ui.failed_5f8945bd"], ["skipped", "ui.skipped_8c40ee29"]]) {
      if (!totals[outcome]) continue;
      const count = element("span", () => t(label) + " " + totals[outcome], "task-check-status");
      count.dataset.outcome = outcome;
      counts.append(count);
    }
    if (counts.childElementCount) area.firstElementChild.after(counts);
    target.append(area);
  }
  section(() => (t("ui.limitations_499c4317")), result.limitations, target);
}

const cardCovers = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    cardCovers.unobserve(target);
    if (!target.isConnected) continue;
    const image = target.querySelector(".task-card-cover");
    const { task, file } = image.dataset;
    const key = task + "\0" + file;
    const cache = cardCoverCache;
    const request = cache.get(key) ?? api.attachmentPreview(task, file);
    cache.set(key, request);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    const discard = () => {
      if (cache.get(key) === request) cache.delete(key);
    };
    void request.then(src => {
      if (!src || src.length > 1_000_000) discard();
      if (src && image.isConnected) image.src = src;
    }).catch(discard);
  }
});

function selectedCover(task, images) {
  const explicit = images.find(file => file.file === task.coverAttachment);
  if (explicit) return explicit;
  // Both attachment commands append their files after the attachments saved at creation.
  const later = (task.history ?? []).reduce((total, event) => total +
    (event.action === "attach" ? 1 : event.chat?.files?.length ?? 0), 0);
  const attachments = task.attachments ?? [];
  const initial = attachments.slice(0, Math.max(0, task.initialAttachments ?? attachments.length - later));
  return initial.find(isImageAttachment);
}

const tagKey = name => name.trim().normalize().toLowerCase();

function tagBadge(name, color) {
  const badge = element("span", name, "tag");
  if (color) badge.style.setProperty("--tag-color", color);
  return badge;
}

function tagBadges(names) {
  const tags = new Map();
  for (const name of names) {
    const key = tagKey(name);
    if (!tags.has(key)) tags.set(key, boardTags.get(key) ?? { name });
  }
  return Array.from(tags.values(), tag => tagBadge(tag.name, tag.color));
}

function renderAgentRunStatus(target, task, { compactQueue = false } = {}) {
  const review = frame.reviewingTasks?.[task.id];
  const label = review === "reviewer" ? t("ui.reviewer_is_reviewing_d6afb5da") :
    review === "manager" ? t("ui.project_manager_is_reviewing_730137f9") :
    frame.runningTasks?.includes(task.id) ? t("ui.agent_is_working_28ccd334") : "";
  if (label) {
    const spinner = target.querySelector(".agent-spinner") ?? icon("sync");
    spinner.classList.add("agent-spinner");
    spinner.removeAttribute("aria-hidden");
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", label);
    spinner.title = label;
    if (!spinner.parentNode) target.replaceChildren(spinner);
  } else {
    const boardTask = frame.board?.tasks.find(card => card.id === task.id);
    const repair = boardTask?.acceptanceRepair;
    const hybridReview = task.status === "review" && (task.reviewModeOverride?.mode ?? frame.board?.settings.reviewMode) === "reviewer-human";
    const waitsForReview = frame.waitingReviewTasks?.includes(task.id);
    const waitsForExecutor = frame.waitingTasks?.includes(task.id);
    const reviewerSlotLabel = "ui.waiting_for_a_reviewer_slot_8918dd95";
    let status = "";
    if (frame.quotaTasks?.includes(task.id)) {
      status = quotaLabel();
    } else if (repair && !(hybridReview && repair.phase === "checking" && !task.reviewApproved)) {
      status = acceptanceRepairStatus(task.id, repair);
    } else if (waitsForReview || waitsForExecutor) {
      if (!waitsForReview && (task.mergeRepair || boardTask?.mergeRepair)) {
        status = t(reviewerSlotLabel);
      } else {
        const queueLabel = () => t(waitsForReview ? reviewerSlotLabel : "ui.waiting_for_an_available_executor_cc0934a8");
        if (compactQueue) {
          // Request text presentation of U+231B.
          const hourglass = element("span", "\u231B\uFE0E", "task-queue-indicator");
          hourglass.setAttribute("role", "img");
          bindLocalized(hourglass, "title", queueLabel);
          bindLocalized(hourglass, "aria-label", queueLabel, true);
          target.replaceChildren(hourglass);
          target.hidden = false;
          return;
        }
        status = queueLabel();
      }
    } else if (task.status === "in_progress" && task.codexThreadId) {
      status = t("ui.board_run_inactive_2a932a2f");
    } else if (hybridReview) {
      status = t(task.reviewApproved ? "ui.awaiting_human_acceptance" : "ui.awaiting_reviewer_approval");
    }
    if (target.firstElementChild || target.textContent !== status) {
      target.textContent = status;
    }
  }
  target.hidden = !target.childNodes.length;
}

function taskIndicator(name, count, label, className) {
  const indicator = element("span", undefined, "task-stat " + className);
  indicator.title = label + " · " + count;
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", indicator.title);
  indicator.append(icon(name), String(count));
  return indicator;
}

function explicitDependencyWait(reason) {
  const plain = reason.replace(/[`*]/g, "").trim();
  const wait = /^(?:задача\s+)?(?:ожидаю|ожидает|ожидается|ожидание|жду|жд[её]т|waiting for|awaiting)\s+/iu;
  if (!wait.test(plain)) return;
  const target = plain.replace(wait, "").replace(
    /^(?:(?:завершени[ея]|при[её]мки|слияния|completion of|acceptance of|merge of)\s+)?(?:задач[аиу]\s+|tasks?\s+)?/iu, "",
  ).replace(/[.!]$/, "");
  if (!/^(?:T-\d{4,}(?:\s*,\s*T-\d{4,})*|другую задачу|another task)$/iu.test(target)) return;
  return [...new Set(target.toUpperCase().match(/T-\d{4,}/g) ?? [])];
}

function dependencyBadge(ids, block) {
  const name = ids.length ? ids[0] + (ids.length > 1 ? " +" + (ids.length - 1) : "") : t("ui.a_task_1d59338e");
  const badge = element("span", undefined, "task-dependency-message dependency-warning");
  badge.append(element("span", () => t("ui.waiting_for_dfc25d0d") + " " + name));
  bindLocalized(badge, "title", () => block ? block.reason + "\n\n" + block.condition :
    t("ui.waiting_for_completion_of_62637861") + " " + ids.join(", "));
  return badge;
}

function blockerBanner({ reason, condition }) {
  const tokenUsageReason = legacyTokenUsageFailure(reason);
  if (tokenUsageReason) {
    reason = tokenUsageReason;
    condition = t("ui.resume_the_task_in_the_same_chat_and_worktree_097e40ef");
  } else if (/already has an active writer/i.test(reason)) {
    reason = t("ui.this_codex_chat_is_already_open_in_another_proce_03a4bf50");
    condition = t("ui.continue_in_the_existing_chat_or_stop_work_there_635dd251");
  }
  const banner = element("span", undefined, "task-blocker");
  banner.append(
    element("strong", () => t("ui.why_it_is_blocked_d0ee1952")),
    element("span", reason, "task-blocker-detail"),
    element("strong", () => t("ui.how_to_continue_4dfef945")),
    element("span", condition, "task-blocker-detail"),
  );
  banner.title = reason + "\n\n" + condition;
  return banner;
}

function quotaLabel() {
  return frame.quotaWait?.resetsAt
    ? t("ui.waiting_for_provider_quota_until", { time: new Date(frame.quotaWait.resetsAt).toLocaleString(frame.localization?.locale) })
    : t("ui.waiting_for_provider_quota");
}

function card(task) {
  const needsAnswer = task.status !== "cancelled" && task.awaitingAnswer === true;
  const showCover = archiveView || frame.board.settings?.showCardPreviews !== false;
  const cover = showCover ? selectedCover(task, (task.attachments ?? []).filter(isImageAttachment)) : undefined;
  // Only visible card data belongs in this key: chat/log/revision updates must not rebuild it.
  const signature = JSON.stringify([frame.localization?.locale, task.title, task.description,
    task.tags?.map(name => boardTags.get(tagKey(name)) ?? { name }), cover?.file,
    frame.runningTasks?.includes(task.id) ?? false, frame.waitingTasks?.includes(task.id) ?? false,
    frame.reviewingTasks?.[task.id], frame.waitingReviewTasks?.includes(task.id),
    frame.quotaTasks?.includes(task.id) ? frame.quotaWait : null, task.status, task.mergeRepair, task.acceptanceRepair, Boolean(task.codexThreadId),
    task.reviewModeOverride?.mode ?? frame.board?.settings.reviewMode, task.reviewApproved,
    task.unfinishedDependencies, task.blocked, task.subtasks?.map(entry => entry.done),
    task.attachments?.length, task.priority, task.dueDate, task.milestone, task.schedule, needsAnswer,
    manualColumns().find(c => c.id === task.status)]);
  const previous = boardCards.get(task.id);
  if (previous?.signature === signature) return previous.node;
  const card = previous?.node ?? button("", () => showTask(task.id, card.dataset.awaitingAnswer === "true"));
  card.dataset.awaitingAnswer = String(needsAnswer);
  const oldDetails = card.querySelector(".task-card-details");
  const oldImage = card.querySelector(".task-card-cover");
  if (oldDetails) cardCovers.unobserve(oldDetails);
  card.className = "task-card";
  card.classList.toggle("task-card-scheduled", Boolean(task.schedule));
  card.dataset.state = task.status;
  card.style.borderLeft = manualBoard() ? `3px solid ${manualColumns().find(c => c.id === task.status)?.color ?? "transparent"}` : "";
  const hasPriority = task.priority && task.priority !== "normal";
  if (hasPriority) {
    card.dataset.priority = task.priority;
  } else {
    delete card.dataset.priority;
  }
  const subtasks = task.subtasks ?? [];
  const completed = subtasks.filter(entry => entry.done).length;
  if (hasPriority || subtasks.length || needsAnswer) {
    bindLocalized(card, "aria-description", () => [
      hasPriority ? t("ui.priority_b114c9b5") + " · " + priorityName(task.priority) : "",
      subtasks.length ? t("ui.subtasks_b409bda5") + " " + completed + "/" + subtasks.length : "",
      needsAnswer ? t("task_question.open_dialogue") : "",
    ].filter(Boolean).join(". "), true);
  } else {
    card.removeAttribute("aria-description");
  }
  const item = element("span", undefined, "task-card-details");
  const heading = element("span", undefined, "task-card-heading");
  heading.append(element("strong", task.title));
  item.append(heading);
  const block = task.status === "blocked" ? task.blocked : undefined;
  const manualWait = block && explicitDependencyWait(block.reason);
  const waiting = manualWait?.length ? manualWait : task.unfinishedDependencies ?? [];
  if (manualWait || (waiting.length && ["ready", "blocked"].includes(task.status))) {
    item.append(dependencyBadge(waiting, manualWait ? block : undefined));
  } else if (task.description && task.status !== "blocked") {
    item.append(cardDescription(task.description));
  }
  if (task.tags?.length) {
    const tags = element("span", undefined, "task-tags");
    tags.append(...tagBadges(task.tags));
    item.append(tags);
  }
  if (cover) {
    const image = oldImage?.dataset.file === cover.file ? oldImage : element("img", undefined, "task-card-cover");
    if (image !== oldImage) {
      image.alt = "";
      image.hidden = true;
      image.dataset.task = task.id;
      image.dataset.file = cover.file;
      image.onload = () => {
        image.hidden = false;
      };
    }
    item.append(image);
  }
  const meta = element("span", undefined, "task-meta");
  const id = element("span", task.id, "task-id task-stat");
  meta.append(id);
  if (needsAnswer) {
    const question = element("span", undefined, "task-question task-stat");
    question.append(icon("question"), element("span", () => t("task_question.needs_answer")));
    bindLocalized(question, "title", () => t("task_question.open_dialogue"));
    meta.append(question);
  }
  if (task.milestone) {
    const { title, repository, number } = task.milestone;
    const badge = element("span", undefined, "task-milestone task-stat");
    badge.append(icon("milestone"), element("span", title, "task-milestone-label"));
    bindLocalized(badge, "title", () => t("ui.github_milestone_11d33bfa") + " · " + title + " · " + repository + " #" + number);
    meta.append(badge);
  }
  if (task.schedule) {
    const { schedule } = task;
    const badge = schedule.paused
      ? schedulePauseIndicator()
      : element("span", undefined, "task-stat");
    if (!schedule.paused) {
      const value = schedule.time ?? scheduleInterval(schedule.everyMinutes, "short");
      badge.append(icon("clock"), value);
    }
    badge.classList.add("task-schedule");
    badge.title = (schedule.paused ? t("ui.schedule_paused") + " · " : "") + scheduleLabel(schedule);
    badge.setAttribute("aria-label", badge.title);
    meta.append(badge);
  }
  if (task.dueDate) {
    const badge = element("span", task.dueDate, "task-stat");
    bindLocalized(badge, "title", () => t("ui.due_date_d764b025"));
    meta.append(badge);
  }
  const runStatus = element("span", undefined, "task-run-status");
  if (task.status === "done" || task.status === "blocked") {
    const done = task.status === "done";
    const indicator = icon(done ? "check" : "lock");
    indicator.classList.add(done ? "task-done" : "task-locked");
    indicator.removeAttribute("aria-hidden");
    indicator.setAttribute("role", "img");
    const label = () => t(done ? "ui.completed_10b5dce8" : "ui.blocked_bd8f5170");
    bindLocalized(indicator, "aria-label", label, true);
    bindLocalized(indicator, "title", label);
    runStatus.append(indicator);
  } else {
    renderAgentRunStatus(runStatus, task, { compactQueue: true });
  }
  if (task.unfinishedDependencies?.length && task.status === "draft") {
    meta.append(taskIndicator("link", task.unfinishedDependencies.length,
      t("ui.unfinished_dependencies_5cfaaab6"), "dependency-warning"));
  }
  if (block && !manualWait) {
    item.append(blockerBanner(block));
  }
  if (subtasks.length) {
    const progress = element("span", undefined, "task-subtask-progress");
    progress.style.setProperty("--subtask-count", subtasks.length);
    progress.setAttribute("aria-hidden", "true");
    for (const subtask of subtasks) {
      const bar = element("span");
      if (subtask.done) bar.classList.add("is-done");
      progress.append(bar);
    }
    item.append(progress);
  }
  if (task.attachments?.length) {
    const attachments = element("span", undefined, "task-stat");
    bindLocalized(attachments, "title", () => t("ui.attachments_3b2db3b4") + " " + task.attachments.length);
    attachments.append(icon("attach"), String(task.attachments.length));
    meta.append(attachments);
  }
  if (runStatus.firstElementChild) {
    const footer = element("span", undefined, "task-card-footer");
    footer.append(meta, runStatus);
    item.append(footer);
  } else {
    if (!runStatus.hidden) item.append(runStatus);
    item.append(meta);
  }
  if (oldDetails) {
    const children = [...item.childNodes];
    const progress = oldDetails.querySelector(".task-subtask-progress");
    const nextProgress = item.querySelector(".task-subtask-progress");
    if (progress && nextProgress && progress.childElementCount === subtasks.length) {
      // Keep the connected segments so CSS can continue or reverse an in-flight fill.
      for (const [index, bar] of [...progress.children].entries()) {
        bar.classList.toggle("is-done", subtasks[index].done);
      }
      children[children.indexOf(nextProgress)] = progress;
    }
    syncChildren(oldDetails, children);
  } else {
    card.replaceChildren(item);
  }
  boardCards.set(task.id, { node: card, signature });
  return card;
}

function syncChildren(target, children) {
  // Keep matching nodes in place; move connected cards without resetting their browser state.
  let cursor = target.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else if (child.isConnected && target.isConnected) target.moveBefore(child, cursor);
    else target.insertBefore(child, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    for (const details of cursor.querySelectorAll(".task-card-details")) cardCovers.unobserve(details);
    cursor.remove();
    cursor = next;
  }
  for (const child of children) {
    const image = child.querySelector(".task-card-cover");
    if (image && !image.getAttribute("src")) cardCovers.observe(image.parentElement);
  }
}

function resetBoardRendering() {
  cardCovers.disconnect();
  laneSizes.disconnect();
  boardCards.clear();
  boardLanes.clear();
  byId("lanes").replaceChildren();
  byId("archive-list").replaceChildren();
  byId("board-composer").firstChild?.dispose?.();
  byId("board-composer").replaceChildren();
}

function switchBoardRendering(previousProject, project) {
  cardCovers.disconnect();
  laneSizes.disconnect();
  const previousComposer = byId("board-composer").firstChild;
  previousComposer?.closeMentions?.();
  previousComposer?.cancelDictation?.();
  previousComposer?.closeQuestion?.();
  previousComposer?.closeQuoteEditor?.();
  if (previousProject && (boardCards.size || boardLanes.size)) {
    boardViews.set(previousProject, {
      cards: boardCards, lanes: boardLanes, covers: cardCoverCache, preferences: lanePreferences,
      columns: [...byId("lanes").childNodes], archive: [...byId("archive-list").childNodes],
      composer: [...byId("board-composer").childNodes],
    });
  }
  const saved = boardViews.get(project);
  boardCards = saved?.cards ?? new Map();
  boardLanes = saved?.lanes ?? new Map();
  cardCoverCache = saved?.covers ?? new Map();
  byId("lanes").replaceChildren(...(saved?.columns ?? []));
  byId("archive-list").replaceChildren(...(saved?.archive ?? []));
  byId("board-composer").replaceChildren(...(saved?.composer ?? []));
  previousComposer?.syncPrompt?.();
  return saved?.preferences;
}

function showUnconfirmedLaunch(task) {
  return !manualBoard() && task.status === "in_progress" && !task.codexThreadId &&
    !frame.runningTasks?.includes(task.id) && !frame.waitingTasks?.includes(task.id);
}

function codexTaskAction(task) {
  if (manualBoard()) return null;
  const generation = projectGeneration;
  if (frame.waitingTasks?.includes(task.id)) {
    const stop = button(() => t("ui.stop_agent_f50db092"), async () => {
      const result = await api.chatStop(task.id);
      if (generation !== projectGeneration) return;
      if (!result.ok) notice(boardError(result.error), task.id);
      else if (sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
    });
    stop.id = "task-stop-waiting";
    return stop;
  }
  if (task.status === "blocked" && task.blocked?.unconfirmedTurn) return null;
  const newThread = task.status === "blocked" && /already has an active writer/i.test(task.blocked?.reason ?? "");
  const missingThread = task.status === "blocked" && task.codexThreadId &&
    task.blocked?.reason === "no rollout found for thread id " + task.codexThreadId;
  const resumeWithFullAccess = task.status === "blocked" && task.executorFullAccess && !newThread && !missingThread;
  const retryExecutor = task.status === "blocked" && task.blocked?.retryExecutor;
  if (task.status !== "ready" && task.status !== "in_progress" && !newThread && !missingThread && !resumeWithFullAccess && !retryExecutor) return null;
  const label = resumeWithFullAccess ? t("ui.continue_with_full_access_18d73ae8")
    : newThread ? t("ui.continue_in_a_new_chat_7364ce62") : retryExecutor ? t("ui.retry_executor_launch") : missingThread || task.status === "in_progress" || task.git
    ? t("ui.continue_06e52fca")
    : t("ui.send_to_work_1c1a04e6");
  const launch = button(label, async () => {
    launch.disabled = true;
    try {
      const result = await api.launchTask(task.id, newThread ? { newThread: true }
        : resumeWithFullAccess ? { resumeWithFullAccess: true } : undefined);
      if (generation !== projectGeneration) return;
      if (!result.ok && result.error.code !== "PROVIDER_QUOTA") notice(boardError(result.error),
        [t("ui.starting_task_1cd51aaa"), task.id, projectName()].join(" · "));
      else if (sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
    } finally {
      launch.disabled = Boolean(frame.quotaWait || task.unfinishedDependencies?.length);
    }
  });
  launch.id = "task-launch";
  launch.hidden = frame.runningTasks?.includes(task.id) ?? false;
  launch.disabled = Boolean(frame.quotaWait || task.unfinishedDependencies?.length);
  return launch;
}

function controlLabel(id, label) {
  const control = byId(id);
  const text = control.querySelector("span");
  if (typeof label === "function") {
    if (text) bindLocalized(text, "textContent", label);
    bindLocalized(control, "title", label);
    bindLocalized(control, "aria-label", label, true);
  } else {
    if (text) text.textContent = label;
    control.title = label;
    control.setAttribute("aria-label", label);
  }
}

function tagChoices(tags, selected) {
  return tags.map(([key, tag]) => {
    const row = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.value = key;
    input.checked = selected.has(key);
    row.append(input, tagBadge(tag.name, tag.color));
    return row;
  });
}

function lanePreferenceKey() {
  return "ai-taskboard:columns:" + frame.project;
}

function loadLanePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(lanePreferenceKey()));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

let laneFitFrame;
const laneSizes = new ResizeObserver(scheduleLaneFit);

function fitLanes(columns) {
  const board = byId("lanes");
  const height = board.clientHeight;
  if (board.hidden || !height) return;
  const bottom = board.getBoundingClientRect().top + height;
  const scrollTop = board.scrollTop;
  const composer = byId("board-composer").getBoundingClientRect();
  // Measure every lane before fitting any of them changes the DOM.
  const measurements = Array.from(columns, lane => {
    const bounds = lane.content.getBoundingClientRect();
    const overlapsComposer = bounds.left < composer.right && bounds.right > composer.left;
    const usableBottom = overlapsComposer ? Math.min(bottom, composer.top) : bottom;
    const visibleHeight = usableBottom - 8 - scrollTop - bounds.top;
    return { lane, availableHeight: visibleHeight * 1.5, bounds };
  });
  for (const { lane, availableHeight, bounds } of measurements) {
    lane.tools.fit(availableHeight, bounds);
  }
}

function scheduleLaneFit() {
  if (laneFitFrame !== undefined) return;
  laneFitFrame = requestAnimationFrame(() => {
    laneFitFrame = undefined;
    fitLanes(boardLanes.values());
  });
}

function laneTools(state, title, tasks, total, count, content) {
  const saved = lanePreferences[state];
  const selected = new Set(Array.isArray(saved?.tags) ? saved.tags.filter(key => boardTags.has(key)) : []);
  const priorities = ["low", "normal", "high", "urgent"];
  const priority = element("select");
  priority.append(localizedOption(t("ui.any_priority_369b9b54"), ""),
    ...priorities.map(value => localizedOption(priorityName(value), value)));
  priority.value = priorities.includes(saved?.priority) ? saved.priority : "";
  let collapsed = saved?.collapsed === true;
  const persist = () => {
    lanePreferences[state] = { tags: [...selected], priority: priority.value, collapsed };
    try {
      localStorage.setItem(lanePreferenceKey(), JSON.stringify({ ...loadLanePreferences(), [state]: lanePreferences[state] }));
    } catch {
      // Preferences stay in this window.
    }
  };
  const toolbar = element("div", undefined, "lane-toolbar");
  const filter = element("details", undefined, "lane-filter");
  const summary = element("summary", undefined, "button quiet");
  const filterLabel = t("ui.column_menu_39181b07") + title;
  const filterCount = element("span", undefined, "count");
  summary.append(icon("more"), filterCount);
  const options = element("div", undefined, "lane-filter-options");
  const priorityLabel = element("label", undefined, "lane-priority");
  priorityLabel.append(element("span", () => t("ui.priority_b114c9b5")), priority);
  const resetLabel = t("ui.reset_column_filter_b2d9ca59");
  const reset = button(resetLabel, clearFilters, "quiet");
  options.append(priorityLabel);
  options.append(...tagChoices([...boardTags].sort(([, a], [, b]) => a.name.localeCompare(b.name)), selected));
  options.append(reset);
  filter.append(summary, options);
  options.addEventListener("change", () => {
    selected.clear();
    for (const checkbox of options.querySelectorAll("input:checked")) selected.add(checkbox.value);
    persist();
    updateCards();
  });
  function clearFilters() {
    priority.value = "";
    selected.clear();
    for (const checkbox of options.querySelectorAll("input:checked")) checkbox.checked = false;
    persist();
    updateCards();
    summary.focus();
  }
  const toggle = button("", () => {
    collapsed = !collapsed;
    persist();
    updateCollapse();
    filter.open = false;
    summary.focus();
  }, "quiet lane-collapse");
  toggle.append(icon("chevron"));
  const toggleText = element("span");
  toggle.append(toggleText);
  toggle.setAttribute("aria-controls", content.id);
  function updateCollapse() {
    content.hidden = collapsed;
    if (!collapsed) scheduleLaneFit();
    const label = (collapsed ? t("ui.expand_985005f3") : t("ui.collapse_38e44992")) + title;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    bindLocalized(toggleText, "textContent", () => collapsed ? t("ui.expand_column_a6eb5979") : t("ui.collapse_column_7c12444e"));
  }
  let empty;
  let matching = [];
  let activeCount = 0;
  let visibleLimit = 4;
  let manualLimit = 0;
  let fitted;
  const more = button("", () => {
    const firstNew = visibleLimit;
    manualLimit = visibleLimit + 4;
    visibleLimit = manualLimit;
    renderBatch();
    // Leave focus at the start of the new batch, rather than on the button moving below it.
    content.children[firstNew]?.focus({ preventScroll: true });
  }, "quiet lane-more");
  function updateCards() {
    matching = tasks.filter(task => (!priority.value || task.priority === priority.value) &&
      (!selected.size || task.tags.some(name => selected.has(tagKey(name)))));
    activeCount = 0;
    if (!manualBoard() && (state === "in_progress" || state === "review")) {
      const active = new Set([...(frame.runningTasks ?? []),
        ...(state === "review" ? Object.keys(frame.reviewingTasks ?? {}) : [])]);
      matching.sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)));
      activeCount = matching.filter(task => active.has(task.id)).length;
    }
    matching.sort((a, b) => Number(Boolean(b.schedule)) - Number(Boolean(a.schedule)));
    const previous = document.activeElement === more ? new Set(content.children) : undefined;
    visibleLimit = Math.max(visibleLimit, activeCount, focusedCardPosition());
    renderBatch();
    if (previous && !more.isConnected) {
      const cards = [...content.querySelectorAll(":scope > .task-card")];
      const next = cards.find(card => !previous.has(card)) ?? cards.at(-1) ?? summary;
      next.focus({ preventScroll: true });
    }
    scheduleLaneFit();
    const active = selected.size + Number(Boolean(priority.value));
    const label = matching.length === total ? String(total) : matching.length + t("ui.of_45303c22") + total;
    if (count.textContent !== label) count.textContent = label;
    if (filterCount.textContent !== String(active)) filterCount.textContent = active;
    filterCount.hidden = active === 0;
    reset.hidden = active === 0;
    summary.title = filterLabel;
    summary.setAttribute("aria-label", active ? filterLabel + " (" + active + ")" : filterLabel);
  }
  const create = manualBoard() ? button("Создать задачу", () => createManualTask(state), "quiet lane-create") : undefined;
  if (create) create.prepend(icon("plus"));
  function renderBatch() {
    fitted = undefined;
    const children = matching.slice(0, visibleLimit).map(card);
    if (matching.length > visibleLimit) {
      const remaining = matching.length - visibleLimit;
      bindLocalized(more, "textContent", () => t("tasks.show_more", { count: remaining }));
      children.push(more);
    }
    const filtered = selected.size || priority.value;
    if (!matching.length && (total || filtered)) {
      if (!empty) {
        empty = element("div", undefined, "lane-filter-empty");
        empty.append(element("p", () => t("ui.no_matching_tasks_5dc41816"), "muted"),
          button(resetLabel, clearFilters, "quiet"));
      }
      empty.querySelector("button").hidden = !filtered;
      children.push(empty);
    }
    if (create) children.push(create);
    syncChildren(content, children);
  }
  function focusedCardPosition() {
    const focused = document.activeElement;
    if (focused?.parentElement !== content || !focused.classList.contains("task-card")) return 0;
    return matching.findIndex(task => boardCards.get(task.id)?.node === focused) + 1;
  }
  function fit(availableHeight, bounds) {
    if (collapsed || !matching.length) return;
    const focused = document.activeElement;
    const firstNew = visibleLimit;
    const minimum = Math.min(matching.length, Math.max(1, manualLimit, activeCount, focusedCardPosition()));
    if (fitted?.availableHeight === availableHeight && fitted.width === bounds.width &&
        fitted.height === bounds.height && fitted.minimum === minimum) return;
    let height = bounds.height;
    const renderAndMeasure = () => {
      renderBatch();
      height = content.getBoundingClientRect().height;
    };
    const limit = Math.min(matching.length, Math.max(visibleLimit, minimum));
    if (visibleLimit !== limit) {
      visibleLimit = limit;
      renderAndMeasure();
    }
    while (visibleLimit > minimum && height > availableHeight) {
      visibleLimit--;
      renderAndMeasure();
    }
    while (visibleLimit < matching.length && height <= availableHeight) {
      visibleLimit++;
      renderAndMeasure();
      if (height <= availableHeight) continue;
      visibleLimit--;
      renderAndMeasure();
      break;
    }
    if (focused === more && document.activeElement !== more) {
      const next = more.isConnected ? more : content.children[firstNew];
      next?.focus({ preventScroll: true });
    }
    fitted = { availableHeight, width: bounds.width, height, minimum };
  }
  updateCards();
  updateCollapse();
  options.append(toggle);
  toolbar.append(filter);
  return { toolbar, fit, update(nextTasks, nextTotal) {
    tasks = nextTasks;
    total = nextTotal;
    updateCards();
  } };
}

function taskChangeTime(task) {
  const updated = Date.parse(task.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const fallback = Date.parse(task.createdAt ?? task.closedAt);
  return Number.isFinite(fallback) ? fallback : -Infinity;
}

function recentlyUpdatedFirst(a, b) {
  return taskChangeTime(b) - taskChangeTime(a) ||
    b.id.localeCompare(a.id, "en", { numeric: true });
}

function cardLayoutChanges(previousBoard, tasks) {
  const previousTasks = new Map(previousBoard.tasks.map(task => [task.id, task]));
  const archivedIds = new Set(previousBoard.archived.map(task => task.id));
  const affected = new Set();
  const added = [];
  for (const task of tasks) {
    const previous = previousTasks.get(task.id);
    const from = previous?.status;
    const to = task.status;
    if (from === to) {
      if (taskChangeTime(previous) !== taskChangeTime(task)) affected.add(to);
      continue;
    }
    if (from !== undefined) affected.add(from);
    else if (!archivedIds.has(task.id)) added.push(task.id);
    affected.add(to);
  }
  return { affectedLanes: [...affected].map(state => boardLanes.get(state)).filter(Boolean), added };
}

function captureCardMoves(affectedLanes) {
  const moves = [];
  for (const { content } of affectedLanes) {
    if (content.hidden) continue;
    for (const node of content.children) {
      if (!node.classList.contains("task-card")) continue;
      const before = node.getBoundingClientRect();
      if (before.width) moves.push({ node, content, before, offsetTop: node.offsetTop });
    }
  }
  return moves;
}

function animateCardMoves(moves) {
  // A neighbor can already be moving toward the same position when another task changes lanes.
  const moved = moves.filter(({ node, content, offsetTop }) => node.parentElement !== content || node.offsetTop !== offsetTop);
  // The starting rectangles include any in-flight motion. Measure the new layout without it.
  for (const { node } of moved) {
    node.getAnimations().find(animation => animation.id === "task-card-move")?.cancel();
  }
  const destinations = moved.flatMap(({ node, content, before }) => {
    const after = node.getBoundingClientRect();
    const x = before.left - after.left;
    const y = before.top - after.top;
    const zIndex = node.parentElement === content ? "auto" : "1";
    return after.width && (x || y) ? [{ node, x, y, zIndex }] : [];
  });
  for (const { node, x, y, zIndex } of destinations) {
    node.animate([
      { transform: `translate(${x}px, ${y}px)`, zIndex },
      { transform: "translate(0, 0)", zIndex },
    ], { id: "task-card-move", duration: 360, easing: "cubic-bezier(.22,.8,.25,1)", fill: "backwards" });
  }
}

function render(previousBoard) {
  // Writing lang invalidates inherited styles throughout the board and chat.
  if (document.documentElement.lang !== localization.locale) {
    document.documentElement.lang = localization.locale;
  }
  renderAppUpdate();
  const board = frame.board;
  const noBoard = !board;
  const autoMode = byId("status-auto-mode");
  autoMode.hidden = noBoard || manualBoard();
  const quota = byId("status-provider-quota");
  quota.hidden = !frame.quotaWait;
  quota.textContent = frame.quotaWait ? quotaLabel() : "";
  const enabled = board?.settings.autoMode === true;
  autoMode.dataset.enabled = String(enabled);
  renderAutoMode();
  autoMode.querySelector("i").className = `icon codicon codicon-${enabled ? "sync" : "play"}`;
  const loading = Boolean(frame.loading || frame.restoring);
  byId("welcome").hidden = !noBoard || loading;
  byId("app-content").setAttribute("aria-busy", String(noBoard && loading));
  byId("workspace").hidden = noBoard;
  byId("archive-menu-item").setAttribute("aria-disabled", String(noBoard));
  byId("board-settings-menu-item").setAttribute("aria-disabled", String(noBoard));
  byId("archive-menu-item").setAttribute("aria-checked", String(archiveView));
  if (!board) {
    resetBoardRendering();
    if (!loading) renderWelcome();
    return;
  }

  const ids = new Set([...board.tasks, ...board.archived].map(task => task.id));
  for (const [id, { node }] of boardCards) {
    if (ids.has(id)) continue;
    const details = node.querySelector(".task-card-details");
    if (details) cardCovers.unobserve(details);
    boardCards.delete(id);
  }

  bindLocalized(byId("workspace"), "aria-label", () => archiveView ? t("ui.archive_d036e225") : t("ui.task_board_063794ec"), true);
  byId("lanes").hidden = archiveView;
  byId("archive-list").hidden = !archiveView;
  byId("board-composer").hidden = archiveView;
  if (!byId("board-composer").firstChild) byId("board-composer").append(draftComposer());
  const composer = byId("board-composer").firstChild;
  composer.localize();
  composer.updateManagerBusy(frame.managerBusy);
  composer.updateManagerRun(frame.managerRun);
  composer.updateManagerWork(frame.managerWork);
  composer.syncManagerUnread(frame.managerUnread);
  if (!archiveView) {
    composer.revealPinned();
  }
  composer.syncPrompt();
  composer.updateQuestion(frame.managerQuestion);
  if (archiveView) {
    const tasks = [...board.archived].sort(recentlyUpdatedFirst);
    syncChildren(byId("archive-list"), tasks.length ? tasks.map(card) :
      [element("p", () => t("ui.no_archived_tasks_found_7157e9bb"), "muted")]);
    return;
  }
  const visible = [...board.tasks].sort(recentlyUpdatedFirst);
  const { affectedLanes, added } = previousBoard && !reducedMotion.matches && !document.hidden ?
    cardLayoutChanges(previousBoard, visible) : { affectedLanes: [], added: [] };
  const moves = captureCardMoves(affectedLanes);
  const focused = document.activeElement;
  const toolsKey = JSON.stringify([frame.localization?.locale, [...boardTags], manualColumns()]);
  const columns = (manualBoard() ? manualColumns().map(c => [c.id, c.name]) : lanes).map(([state, labelKey]) => {
    const tasks = visible.filter(task => task.status === state);
    let lane = boardLanes.get(state);
    if (!lane) {
      const column = element("section", undefined, "lane");
      column.dataset.state = state;
      const header = element("div", undefined, "lane-header");
      const content = element("div", undefined, "lane-cards");
      content.id = "lane-cards-" + state;
      column.append(header, content);
      lane = { column, header, content };
      boardLanes.set(state, lane);
    }
    const title = manualBoard() ? labelKey : t(labelKey);
    const statusColor = manualColumns().find(c => c.id === state)?.color;
    lane.column.style.borderTop = statusColor ? `3px solid ${statusColor}` : "";
    const total = tasks.length;
    if (lane.toolsKey !== toolsKey) {
      const heading = element("h2", undefined, "lane-title");
      heading.title = title;
      const count = element("span", undefined, "count");
      heading.append(element("span", title), count);
      lane.tools = laneTools(state, title, tasks, total, count, lane.content);
      lane.header.replaceChildren(heading, lane.tools.toolbar);
      lane.toolsKey = toolsKey;
    } else lane.tools.update(tasks, total);
    return lane.column;
  });
  const boardViewport = byId("lanes");
  syncChildren(boardViewport, columns);
  laneSizes.observe(boardViewport);
  laneSizes.observe(byId("board-composer"));
  for (const lane of boardLanes.values()) laneSizes.observe(lane.column);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  // An incoming card can temporarily push a visible neighbor out of the current batch.
  if (affectedLanes.length) fitLanes(affectedLanes);
  animateCardMoves(moves);
  for (const id of added) {
    const node = boardCards.get(id)?.node;
    if (!node?.getClientRects().length) continue;
    node.animate([{ opacity: 0 }, { opacity: 1 }],
      { id: "task-card-enter", duration: 280, easing: "ease-out", fill: "backwards" });
  }
}

function renderWelcome() {
  const loading = Boolean(frame.loading);
  byId("welcome").setAttribute("aria-busy", String(loading));
  bindLocalized(byId("welcome-start"), "textContent", () => t("ui.start_803a28bf"));
  bindLocalized(byId("welcome-recent"), "textContent", () => t("ui.recent_boards_efd567a4"));
  controlLabel("welcome-create", () => (t("ui.create_board_e02d5c15")));
  controlLabel("welcome-open", () => (t("ui.open_existing_board_754e46e5")));
  byId("welcome-create").disabled = loading;
  byId("welcome-open").disabled = loading;
  const recent = frame.recentBoards ?? [];
  byId("recent-empty").hidden = recent.length > 0;
  bindLocalized(byId("recent-empty"), "textContent", () => t("ui.no_recent_boards_yet_300a7f50"));
  byId("recent-boards").replaceChildren(...recent.map(({ name, path }) => {
    const row = element("li");
    const open = button("", () => api.openRecent(path), "welcome-link recent-board");
    open.disabled = loading;
    open.append(element("span", name), element("span", path, "muted"));
    row.append(open);
    return row;
  }));
}

const lineList = value => value.split("\n").map(line => line.trim()).filter(Boolean);
const shortDate = value => new Date(value).toLocaleString(localization.locale);
const priorityName = value => ({
  low: t("ui.low_9de7ee06"), normal: t("ui.normal_4c9f45d6"),
  high: t("ui.high_3401144e"), urgent: t("ui.urgent_14496422"),
})[value] || value;

function form(kind, title, fields, label, submit) {
  openSheet(kind, title);
  const form = element("form", undefined, "form");
  const inputs = {};
  for (const field of fields) {
    const row = element("label", field.label);
    const input = element(field.type === "area" ? "textarea" : field.options ? "select" : "input");
    if (field.options) {
      for (const [value, label] of field.options) {
        const option = element("option", label);
        option.value = value;
        input.append(option);
      }
    } else if (field.type !== "area") input.type = field.type || "text";
    input.name = field.name;
    if (field.type === "number") input.min = "0";
    input.required = Boolean(field.required);
    if (field.type === "checkbox") {
      input.checked = Boolean(field.value);
      row.classList.add("form-checkbox");
      row.prepend(input);
    } else {
      input.value = field.value ?? "";
      row.append(input);
    }
    inputs[field.name] = input;
    form.append(row);
  }
  const save = element("button", label, "button primary");
  save.type = "submit";
  form.append(save);
  const saveFields = protect(async () => {
    try {
      await submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) =>
        [key, input.type === "checkbox" ? input.checked : input.value])));
    } finally { save.disabled = false; }
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    saveFields();
  });
  body.append(form);
  return form;
}

function managerQuestionDialog(question, trigger) {
  const dialog = element("dialog", undefined, "sheet manager-question");
  const title = element("h2", () => question.approval ? t("ui.manager_access_request_24f7039f") :
    t("ui.question_from_the_project_manager_cf39c2b5"));
  title.id = "manager-question-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = button("", () => dialog.close(), "quiet icon-button");
  close.append(icon("close"));
  controlLabelForIcon(close, () => t("ui.close_question_4ef77ca0"));
  const header = element("header", undefined, "sheet-header");
  header.append(title, close);
  const form = element("form", undefined, "sheet-body form");
  const prompt = chatText(question.text, {});
  prompt.classList.add("manager-question-text");
  prompt.id = "manager-question-text";
  dialog.setAttribute("aria-describedby", prompt.id);
  const choices = element("div", undefined, "manager-question-options");
  const label = element("label", () => t("ui.your_answer_66fd757f"));
  const input = element("textarea");
  input.maxLength = 4000;
  label.append(input);
  const error = element("p", "", "chat-status");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = element("div", undefined, "sheet-actions");
  const submit = element("button", () => t("ui.send_answer_a3fdd777"), "button primary");
  submit.type = "submit";
  const skip = button(() => t("ui.skip_question_773b15fa"), () => send(null), "quiet");
  actions.append(submit, skip);
  const options = question.options.map(value => {
    const option = button("", () => send(value), "quiet");
    const caption = element("span", value, "chat-text");
    if (chatMarkdown) {
      const template = document.createElement("template");
      template.innerHTML = chatMarkdown.renderInline(value);
      // Keep the whole caption a single answer target, with no nested links or image requests.
      for (const link of template.content.querySelectorAll("a")) link.replaceWith(...link.childNodes);
      for (const image of template.content.querySelectorAll("img")) image.replaceWith(document.createTextNode(image.alt));
      caption.replaceChildren(template.content);
      if (!caption.textContent.trim()) caption.textContent = value;
    }
    option.append(caption);
    return option;
  });
  choices.append(...options);
  const controls = [close, skip, ...options];
  let sending = false;
  const validate = () => { submit.disabled = sending || !input.value.trim(); };
  async function send(answer) {
    if (sending || !dialog.open) return;
    sending = true;
    for (const control of controls) control.disabled = true;
    input.readOnly = true;
    error.hidden = true;
    validate();
    try {
      const result = await api.answerBoardQuestion(question.id, answer);
      if (!result.ok) throw new Error(boardError(result.error));
      if (dialog.open) dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      sending = input.readOnly = false;
      for (const control of controls) control.disabled = false;
      validate();
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (input.value.trim()) void send(input.value.trim());
  });
  input.addEventListener("input", validate);
  validate();
  form.append(prompt);
  if (options.length) form.append(choices);
  if (question.approval) form.append(error);
  else form.append(label, error, actions);
  dialog.append(header, form);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger.isConnected && !trigger.hidden) trigger.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const activityRowKey = id => id.replace(/^final:/, "message:").replace(/^group:/, "item:");

function chatViewport(list) {
  const rows = "[data-item], [data-chat-anchor]";
  const key = row => row.dataset.chatAnchor ?? activityRowKey(row.dataset.item);
  const report = ".chat-report-details";
  const reportBlocks = report + "[open] > .chat-report-body > *";
  const foldsSelector = "details[data-item], " + report;
  function foldKey(fold) {
    if (!fold.matches(report)) return fold.dataset.item;
    const message = fold.parentElement.closest(rows);
    if (!message) return fold.dataset.item;
    const sections = [...fold.parentElement.querySelectorAll(":scope > " + report)];
    return JSON.stringify(["report", key(message), sections.indexOf(fold)]);
  }
  function anchorKey(row) {
    const body = row.parentElement;
    if (!body.matches(".chat-report-body")) return key(row);
    const section = foldKey(body.parentElement);
    if (section) return JSON.stringify(["report-block", section, [...body.children].indexOf(row)]);
  }
  const rowBounds = row => (row.matches("details") ? row.firstElementChild ?? row : row).getBoundingClientRect();
  const visible = row => row.checkVisibility({ visibilityProperty: true });
  let suspended = false;
  let restoring = false;
  const hasViewport = () => !suspended && list.clientHeight && visible(list);
  let position = { end: true, top: 0, anchors: [] };
  const atEnd = () => suspended ? position.end : list.scrollHeight - list.scrollTop - list.clientHeight <= 1;
  let restoredTop;
  let folds;
  function remember() {
    if (restoring || !hasViewport()) return;
    const top = list.getBoundingClientRect().top;
    const end = atEnd();
    const anchors = [];
    if (!end) {
      const bottom = top + list.clientHeight;
      // Text wraps differently after a resize, so prefer anchors inside open reports.
      const anchorContainers = [...list.children].filter(child => {
        // Reading a descendant's bounds would lay out a skipped history run.
        if (child.style.contentVisibility !== "auto") return true;
        const bounds = child.getBoundingClientRect();
        return bounds.bottom > top && bounds.top < bottom;
      });
      for (const selector of [reportBlocks, rows]) {
        const candidates = anchorContainers.flatMap(child => [
          ...(child.matches(selector) ? [child] : []),
          ...child.querySelectorAll(selector),
        ]);
        for (const row of candidates) {
          if (!visible(row)) continue;
          const bounds = rowBounds(row);
          if (!bounds.height || bounds.bottom <= top || bounds.top >= bottom) continue;
          const id = anchorKey(row);
          if (id) anchors.push({ node: row, key: id, offset: bounds.top - top });
          if (anchors.length === 4) break;
        }
        if (anchors.length === 4) break;
      }
    }
    position = { end, top: list.scrollTop, anchors };
    restoredTop = list.scrollTop;
  }
  function restore() {
    if (!hasViewport()) return;
    if (position.end) list.scrollTop = list.scrollHeight;
    else {
      const candidates = [...list.querySelectorAll(rows + ", " + reportBlocks)];
      let top = position.top;
      for (const anchor of position.anchors) {
        const connected = anchor.node && list.contains(anchor.node);
        const row = connected ? anchor.node : candidates.find(candidate => anchorKey(candidate) === anchor.key);
        if (!row) continue;
        if (!connected && !visible(row)) {
          for (let fold = row.parentElement.closest(".chat-work"); fold; fold = fold.parentElement.closest(".chat-work")) fold.open = true;
        }
        if (!visible(row) || !rowBounds(row).height) continue;
        top = list.scrollTop + rowBounds(row).top - list.getBoundingClientRect().top - anchor.offset;
        break;
      }
      list.scrollTop = top;
    }
    restoring = false;
    remember();
  }
  const resize = new ResizeObserver(restore);
  resize.observe(list);
  const observed = new Set();
  function observeRows() {
    const children = new Set(list.children);
    for (const child of observed) if (!children.has(child)) resize.unobserve(child);
    for (const child of children) if (!observed.has(child)) resize.observe(child);
    observed.clear();
    for (const child of children) observed.add(child);
  }
  list.addEventListener("scroll", () => {
    if (list.scrollTop !== restoredTop) remember();
  });
  return {
    atEnd,
    restore,
    remember,
    suspend(change) {
      remember();
      folds = new Map();
      for (const fold of list.querySelectorAll(foldsSelector)) {
        const id = foldKey(fold);
        if (id) folds.set(id, fold.open);
      }
      suspended = true;
      resize.disconnect();
      observed.clear();
      for (const anchor of position.anchors) delete anchor.node;
      change();
    },
    resume(change) {
      change();
      if (!suspended) return;
      for (const fold of list.querySelectorAll(foldsSelector)) {
        const id = foldKey(fold);
        if (folds.has(id)) fold.open = folds.get(id);
      }
      folds = undefined;
      restoring = true;
      suspended = false;
      resize.observe(list);
      observeRows();
      restore();
    },
    followEnd() {
      position.end = true;
      restore();
    },
    update(change) {
      remember();
      change();
      if (!suspended) observeRows();
      restore();
    },
    dispose: () => resize.disconnect(),
  };
}

function draftComposer() {
  const project = frame.project;
  const files = [];
  const quotes = [];
  const queued = [];
  let savingQueuedMessage = false;
  let sendingQueuedMessage = false;
  let active;
  let managerRun;
  let managerBusy = false;
  let queueRetry;
  let managerWork;
  let startingWork = false;
  let disposed = false;
  const editor = element("form", undefined, "board-draft");
  editor.id = "board-draft";
  editor.setAttribute("aria-busy", "false");
  const chat = element("section", undefined, "board-chat");
  chat.addEventListener("animationend", event => {
    if (event.animationName === "board-chat-enter") event.target.removeAttribute("data-enter");
    if (event.animationName === "board-chat-text-fade") event.target.classList.remove("chat-stream-fragment");
  });
  chat.id = "board-chat";
  const bar = element("div", undefined, "board-chat-bar");
  const resize = element("div", undefined, "board-chat-resize");
  resize.tabIndex = 0;
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-orientation", "horizontal");
  resize.setAttribute("aria-controls", chat.id);
  resize.append(element("span"));
  const preferencesKey = "taskboard.orchestrator:" + project;
  let preferences;
  try { preferences = JSON.parse(localStorage.getItem(preferencesKey)); } catch {}
  let pinned = preferences?.pinned === true;
  let height = Number.isFinite(preferences?.height) ? preferences.height : undefined;
  let waitingForChat = false;
  let canStop = false;
  let stopping = false;
  let goalMode = false;
  let dictation;
  const persist = () => {
    try { localStorage.setItem(preferencesKey, JSON.stringify({ pinned, height })); } catch {}
  };
  const pin = button("", () => {
    pinned = !pinned;
    editor.setAttribute("data-open", "");
    updatePin();
    syncPrompt();
    persist();
  }, "quiet board-chat-pin");
  const updatePin = () => {
    editor.toggleAttribute("data-pinned", pinned);
    pin.setAttribute("aria-pressed", String(pinned));
    pin.replaceChildren(icon(pinned ? "pinned" : "pin"));
    controlLabelForIcon(pin, () => pinned ? t("ui.unpin_chat_5476c9a7") : t("ui.pin_chat_5352ca60"));
  };
  const resizeChat = next => {
    const limit = Math.max(0, window.innerHeight - 160);
    const min = Math.min(160, limit);
    height = Math.round(Math.min(limit, Math.max(min, next)));
    editor.style.setProperty("--board-chat-height", height + "px");
    resize.setAttribute("aria-valuemin", String(Math.round(min)));
    resize.setAttribute("aria-valuemax", String(Math.round(limit)));
    resize.setAttribute("aria-valuenow", String(height));
  };
  if (height !== undefined) editor.style.setProperty("--board-chat-height", height + "px");
  resize.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const y = event.clientY;
    const initialHeight = chat.getBoundingClientRect().height;
    editor.setAttribute("data-resizing", "");
    resize.setPointerCapture(event.pointerId);
    resize.onpointermove = move => resizeChat(initialHeight + y - move.clientY);
  });
  const finishResize = () => {
    if (!editor.hasAttribute("data-resizing")) return;
    editor.removeAttribute("data-resizing");
    resize.onpointermove = null;
    persist();
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(event, finishResize);
  resize.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resizeChat(chat.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24));
    persist();
  });
  const views = element("div", undefined, "board-chat-views");
  views.hidden = true;
  const dialogueToggle = button("", () => showWork(false), "quiet board-dialogue-toggle");
  const workToggle = button("", () => showWork(true), "quiet board-work-toggle");
  dialogueToggle.setAttribute("aria-pressed", "true");
  workToggle.setAttribute("aria-pressed", "false");
  views.append(dialogueToggle, workToggle);
  bar.append(views, resize, pin);
  let currentGoal;
  let goalScope;
  let goalLogAvailable = false;
  let goalAvailabilityRevision = 0;
  let goalRunning = false;
  let goalResuming = false;
  let goalResumeWaiting = false;
  let resumeRequest;
  let clearingGoal = false;
  let goalRevision = 0;
  let changingGoal = false;
  const goalPanel = element("details", undefined, "board-goal");
  goalPanel.hidden = true;
  const goalSummary = element("summary");
  const goalHeading = element("span", undefined, "board-goal-heading");
  const goalStatus = element("span", undefined, "board-goal-status");
  goalStatus.setAttribute("role", "status");
  const goalTitle = element("span", undefined, "board-goal-title");
  goalHeading.append(icon("target"), goalStatus, goalTitle);
  goalSummary.append(goalHeading);
  const goalBody = element("div", undefined, "board-goal-body");
  const goalText = element("textarea");
  goalText.rows = 2;
  const goalError = element("div", undefined, "board-goal-error");
  goalError.setAttribute("role", "alert");
  const goalPending = element("div");
  goalPending.setAttribute("role", "status");
  goalPending.hidden = true;
  const goalActions = element("div", undefined, "board-goal-actions");
  const saveGoal = button("", () => changeGoal("edit", goalText.value.trim()), "quiet");
  const pauseGoal = button("", () => changeGoal("pause"), "quiet");
  const resumeGoal = button("", async () => {
    if (!currentGoal || resumeGoal.hidden || resumeGoal.disabled) return;
    const request = Symbol();
    resumeRequest = request;
    goalError.textContent = "";
    syncGoal();
    try {
      const result = await api.boardGoal("resume", currentGoal.objective);
      if (!result.ok) throw new Error(boardError(result.error));
    } catch (error) {
      if (resumeRequest === request) {
        goalError.textContent = error.message;
      }
    } finally {
      if (resumeRequest === request) {
        resumeRequest = undefined;
        syncGoal();
      }
    }
  }, "quiet");
  const clearGoal = button("", () => changeGoal("clear"), "quiet danger");
  goalActions.append(saveGoal, pauseGoal, resumeGoal, clearGoal);
  goalBody.append(goalText, goalActions, goalPending, goalError);
  goalPanel.append(goalSummary, goalBody);
  const goalLabels = {
    active: ["ui.active_goal_4b86aa5f"], paused: ["ui.goal_paused_9030eeb9"],
    blocked: ["ui.goal_blocked_553f6449"], complete: ["ui.goal_completed_a63116cb"],
    usageLimited: ["ui.usage_limit_reached_32616e2a"], budgetLimited: ["ui.token_budget_reached_7e820132"],
  };
  const syncGoal = () => {
    if (!currentGoal) return;
    const settings = frame.board?.settings;
    const automatic = settings?.autoMode && frame.goalIteration?.enabled && frame.iterativeGoalId === goalScope;
    const waitingForWork = automatic && currentGoal.status === "active" && !goalRunning;
    const waitingToResume = currentGoal.status === "active" && !goalRunning && !waitingForWork;
    bindLocalized(goalStatus, "textContent", () => waitingForWork ? t("autoMode.waitingForWork") : waitingToResume ? t("ui.goal_awaiting_continuation_27d0b1c3") :
      t(...(goalLabels[currentGoal.status] ?? ["ui.goal_1730d64f"])));
    goalPanel.dataset.status = waitingToResume ? "idle" : currentGoal.status;
    pauseGoal.hidden = currentGoal.status !== "active" || waitingToResume;
    resumeGoal.hidden = currentGoal.status === "complete" || !pauseGoal.hidden;
    const resuming = goalResuming || resumeRequest !== undefined;
    resumeGoal.disabled = changingGoal || resuming;
    goalPending.hidden = !clearingGoal && (!resuming || goalRunning);
    bindLocalized(goalPending, "textContent", () => t(clearingGoal
      ? "ui.waiting_for_the_codex_chat_to_become_available_ddb2e85f"
      : goalResumeWaiting ? "ui.waiting_for_goal_context" : "ui.starting_39fd3c7e"));
    saveGoal.disabled = changingGoal || !goalText.value.trim() || goalText.value.trim() === currentGoal.objective;
    pauseGoal.disabled = clearGoal.disabled = changingGoal;
  };
  const showGoal = goal => {
    const wasEditing = currentGoal && goalText.value !== currentGoal.objective;
    if (!wasEditing || !goal) goalText.value = goal?.objective ?? "";
    currentGoal = goal;
    goalPanel.hidden = !goal;
    if (!goal) goalPanel.open = false;
    goalTitle.textContent = goal?.objective ?? "";
    goalTitle.title = goalTitle.textContent;
    syncGoal();
  };
  editor.updateGoal = (goal, running, resuming, metadata = {}) => {
    goalRevision++;
    if (running !== undefined) goalRunning = running;
    if (resuming !== undefined) goalResuming = resuming;
    if (metadata.goalResumeEvent) {
      // Once main broadcasts the attempt, the shared state owns the outcome in every window.
      resumeRequest = undefined;
    }
    if (metadata.goalResumeWaiting !== undefined) goalResumeWaiting = metadata.goalResumeWaiting;
    if (resuming === true) goalError.textContent = "";
    if (metadata.goalResumeError) goalError.textContent = metadata.goalResumeError;
    if (metadata.goalLogAvailable !== undefined) {
      goalAvailabilityRevision++;
      goalLogAvailable = metadata.goalLogAvailable;
    }
    if (metadata.goalId !== undefined) goalScope = metadata.goalId;
    if (goal !== undefined) showGoal(goal);
    else syncGoal();
    syncViews();
    syncPrompt();
  };
  goalText.addEventListener("input", syncGoal);
  async function changeGoal(kind, objective) {
    if (changingGoal) return;
    changingGoal = true;
    goalError.textContent = "";
    clearingGoal = kind === "clear";
    const revision = goalRevision;
    syncGoal();
    try {
      const result = await api.boardGoal(kind, objective);
      if (!result.ok) throw new Error(boardError(result.error));
      if (kind === "edit" && goalText.value.trim() === objective) goalText.value = result.data?.objective ?? "";
      if (revision === goalRevision) editor.updateGoal(result.data);
    } catch (error) {
      goalError.textContent = error.message;
    } finally {
      changingGoal = false;
      clearingGoal = false;
      syncGoal();
    }
  }
  const log = element("div", undefined, "board-chat-log");
  const dialogueViewport = chatViewport(log);
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.tabIndex = 0;
  const unreadDivider = element("div", undefined, "board-chat-unread");
  let unread = new Set(frame.managerUnread ?? []);
  let readFrame;
  let readRetry;
  let readingMessages = false;
  function updateUnreadMessages() {
    let first;
    for (const bubble of log.querySelectorAll(".board-manager-message[data-message-id]")) {
      const read = !unread.has(bubble.dataset.messageId);
      bubble.dataset.read = String(read);
      if (!read && !first) first = bubble;
    }
    if (first && unreadDivider.nextElementSibling !== first) first.before(unreadDivider);
    if (!first) unreadDivider.remove();
    return first;
  }
  function readVisibleMessages() {
    clearTimeout(readRetry);
    clearTimeout(queueRetry);
    if (!canBrowseHistory() || !api.readManagerMessages || !unread.size || readFrame || readingMessages) return;
    readFrame = requestAnimationFrame(async () => {
      readFrame = undefined;
      if (disposed || loadingHistory || !editor.isConnected || frame.project !== project || document.hidden ||
          !document.hasFocus() || document.querySelector("dialog:modal") || !editor.matches("[data-open], [data-pinned]") ||
          !log.checkVisibility({ visibilityProperty: true }) || !log.clientHeight) return;
      const viewport = log.getBoundingClientRect();
      const ids = [...log.querySelectorAll('.board-manager-message[data-message-id]')].filter(bubble => {
        if (!bubble.checkVisibility({ visibilityProperty: true })) return false;
        const bounds = bubble.getBoundingClientRect();
        return bounds.height > 0 && bounds.top >= viewport.top - 1 && bounds.top + Math.min(bounds.height, 28) <= viewport.bottom;
      }).slice(0, 200).map(bubble => bubble.dataset.messageId);
      if (!ids.length) return;
      const snapshot = new Set(unread);
      readingMessages = true;
      try {
        const result = await api.readManagerMessages(project, ids);
        if (result.ok) {
          for (const id of snapshot) if (!result.data.includes(id)) unread.delete(id);
          dialogueViewport.update(updateUnreadMessages);
        }
      } catch {
        // Leave the messages unread so the next viewport update can retry.
      } finally {
        readingMessages = false;
        // Updates and scrolls during the IPC call may have exposed another reply.
        // Retry failures as well, without requiring another user gesture.
        if (!disposed && canBrowseHistory() && unread.size) readRetry = setTimeout(readVisibleMessages, 500);
      }
    });
  }
  editor.syncManagerUnread = ids => {
    if (ids && (ids.length !== unread.size || ids.some(id => !unread.has(id)))) {
      unread = new Set(ids);
      dialogueViewport.update(updateUnreadMessages);
    }
    readVisibleMessages();
  };
  let positionNewDialogue = false;
  function showDialoguePosition() {
    if (!canBrowseHistory()) return;
    if (positionNewDialogue && log.clientHeight && log.checkVisibility({ visibilityProperty: true })) {
      positionNewDialogue = false;
      if (updateUnreadMessages()) {
        log.scrollTop += unreadDivider.getBoundingClientRect().top - log.getBoundingClientRect().top;
        lastScrollTop = log.scrollTop;
        dialogueViewport.remember();
      } else dialogueViewport.followEnd();
    }
    readVisibleMessages();
  }
  const readObserver = new ResizeObserver(showDialoguePosition);
  const work = element("section", undefined, "board-chat-log board-work");
  const workViewport = chatViewport(work);
  work.hidden = true;
  work.tabIndex = 0;
  const workTimeline = element("div", undefined, "chat-run board-work-timeline");
  const workError = element("p", undefined, "muted");
  workError.hidden = true;
  const workStatus = element("p", undefined, "muted");
  workStatus.setAttribute("role", "status");
  workStatus.hidden = true;
  bindLocalized(workStatus, "textContent", () => t("ui.loading_2ad65fd8"));
  const workOlder = button(() => t("ui.earlier_activity_e8606f75"), () => void loadWork(workCursor), "quiet board-chat-older");
  workOlder.hidden = true;
  work.append(workOlder, workStatus, workTimeline, workError);
  let workCursor;
  let workLoading = false;
  let workReload = false;
  let workLivePending = false;
  let workLiveDirty = false;
  let liveWork = [];
  const pendingWork = new Map();
  let savedWorkIds = new Set();
  let savedWork = [];
  let olderWorkLoaded = false;
  let hasWorkHistory = false;
  function renderGoalTimeline() {
    renderActivity(workTimeline, goalTimeline(savedWork, liveWork, pendingWork.values()), true, {
      managerWork: true, liveIds: new Set(liveWork.map(item => item.id)),
    });
  }
  async function loadWork(cursor = null) {
    if (disposed || work.hidden || !canBrowseHistory()) return;
    if (workLoading) {
      if (!cursor) workReload = true;
      return;
    }
    workLoading = true;
    workOlder.disabled = true;
    workStatus.hidden = false;
    try {
      let next = cursor;
      const visited = new Set();
      const turns = [];
      // Keep the oldest loaded page when new events shift the page boundaries.
      const oldest = !cursor && (olderWorkLoaded || !workViewport.atEnd()) ? savedWork[0] : undefined;
      const oldestMessage = oldest?.messages[0]?.clientId;
      const oldestItem = oldest?.items[0]?.id;
      let reachedOldest = !oldest;
      const revision = goalRevision;
      do {
        visited.add(next);
        const result = await api.boardHistory(project, next, "work");
        if (disposed || work.hidden || !canBrowseHistory()) return;
        if (!result.ok) throw new Error(boardError(result.error));
        if (visited.size === 1 && revision === goalRevision) {
          editor.updateGoal(result.data.goal, result.data.goalRunning, result.data.goalResuming, result.data);
          if (work.hidden) return;
        }
        turns.unshift(...result.data.turns);
        reachedOldest ||= result.data.turns.some(turn =>
          (oldestMessage !== undefined && turn.messages.some(message => message.clientId === oldestMessage)) ||
          turn.items.some(item => item.id === oldestItem));
        next = result.data.nextCursor;
        // A broken provider cursor must not keep the loading loop alive.
        if (visited.has(next)) next = null;
      } while (next && (!reachedOldest || !turns.length));
      workViewport.update(() => {
        // Pages arrive newest first, while turns within each page are chronological.
        if (cursor) savedWork.unshift(...turns);
        else savedWork = turns;
        savedWorkIds = new Set(savedWork.flatMap(turn => [
          ...turn.messages.map(message => message.clientId),
          ...turn.items.map(item => item.id),
        ]));
        for (const id of savedWorkIds) pendingWork.delete(id);
        olderWorkLoaded ||= Boolean(cursor);
        workCursor = next;
        workOlder.hidden = !workCursor;
        workError.hidden = true;
        renderGoalTimeline();
      });
      if (!hasWorkHistory) workViewport.followEnd();
      hasWorkHistory = true;
      editor.refreshWork();
    } catch (error) {
      if (!disposed && canBrowseHistory()) {
        workViewport.update(() => {
          workError.textContent = error.message;
          workError.hidden = false;
          workOlder.hidden = false;
          renderGoalTimeline();
        });
      }
    } finally {
      workLoading = false;
      workOlder.disabled = false;
      workStatus.hidden = true;
      if (workReload) {
        workReload = false;
        void loadWork();
      }
    }
  }
  function syncViews() {
    views.hidden = !(goalRunning || startingWork || goalLogAvailable ||
      (currentGoal && currentGoal.status !== "complete"));
    if (views.hidden && !work.hidden) showWork(false);
  }
  function showWork(show) {
    if (show && views.hidden) return;
    if (show === !work.hidden) return;
    work.hidden = !show;
    log.hidden = show;
    dialogueToggle.setAttribute("aria-pressed", String(!show));
    workToggle.setAttribute("aria-pressed", String(show));
    if (!show) {
      dialogueViewport.restore();
      dialogueViewport.update(updateUnreadMessages);
      showDialoguePosition();
      return;
    }
    dialogueViewport.update(() => unreadDivider.remove());
    workViewport.restore();
    editor.invalidateWork();
    editor.refreshWork();
  }
  editor.invalidateWork = () => {
    if (work.hidden) {
      const revision = goalRevision;
      void api.boardHistory(project, null, "work").then(result => {
        if (!disposed && result.ok && revision === goalRevision) {
          editor.updateGoal(result.data.goal, result.data.goalRunning, result.data.goalResuming, result.data);
        }
      }).catch(() => {});
      return;
    }
    void loadWork();
  };
  editor.refreshWork = async () => {
    if (disposed || work.hidden || !editor.matches("[data-open], [data-pinned]")) return;
    if (workLivePending) {
      workLiveDirty = true;
      return;
    }
    workLivePending = true;
    try {
      const result = await api.boardHistory(project, null, "live");
      if (disposed || work.hidden || !canBrowseHistory() || !result.ok) return;
      const previousLive = liveWork;
      liveWork = [...(result.data.work ?? []), ...(result.data.chat ?? [])];
      const liveIds = new Set(liveWork.map(item => item.id));
      // A completed run can disappear from live before it reaches the loaded pages.
      for (const item of previousLive) {
        if (!liveIds.has(item.id) && !savedWorkIds.has(item.id)) pendingWork.set(item.id, item);
      }
      for (const id of liveIds) pendingWork.delete(id);
      if (!workLoading) workViewport.update(renderGoalTimeline);
      if (previousLive.length && !liveWork.length) void loadWork();
    } catch {
      // The next activity update will refresh the panel.
    } finally {
      workLivePending = false;
      if (workLiveDirty) {
        workLiveDirty = false;
        void editor.refreshWork();
      }
    }
  };
  const disclosures = new WeakMap();
  log.addEventListener("click", event => {
    const detail = event.target.closest("summary")?.parentElement;
    if (detail?.tagName !== "DETAILS" || reducedMotion.matches) return;
    event.preventDefault();
    const from = detail.getBoundingClientRect().height;
    const previous = disclosures.get(detail);
    previous?.animation.cancel();
    const open = previous ? !previous.open : !detail.open;
    detail.open = open;
    const to = detail.getBoundingClientRect().height;
    detail.open = true;
    const animation = detail.animate([
      { height: from + "px", overflow: "clip" },
      { height: to + "px", overflow: "clip" },
    ], { duration: 180, easing: "cubic-bezier(.2,.75,.25,1)" });
    disclosures.set(detail, { animation, open });
    animation.onfinish = () => {
      detail.open = open;
      disclosures.delete(detail);
    };
  });
  const greeting = element("p", undefined, "muted");
  const olderHistory = button("", () => loadOlderHistory(), "quiet board-chat-older");
  olderHistory.hidden = true;
  const queue = element("div", undefined, "board-chat-queue");
  queue.setAttribute("role", "list");
  log.append(olderHistory, greeting);
  chat.append(bar, goalPanel, log, work, queue);
  const input = element("textarea");
  input.name = "request";
  input.rows = 1;
  input.placeholder = " ";
  input.setAttribute("aria-controls", chat.id);
  const prompt = element("span", undefined, "draft-placeholder");
  prompt.setAttribute("aria-hidden", "true");
  const hint = element("p", undefined, "muted draft-hint");
  hint.id = "board-paste-hint";
  input.setAttribute("aria-describedby", hint.id);
  const controls = element("div", undefined, "draft-controls");
  const picker = element("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  const add = element("button", undefined, "button quiet draft-add chat-add");
  add.type = "button";
  add.append(icon("add"));
  const menu = element("div", undefined, "draft-add-menu");
  menu.popover = "auto";
  add.popoverTargetElement = menu;
  const menuHeading = element("div", undefined, "draft-menu-heading muted");
  const menuActions = element("div", undefined, "draft-menu-actions");
  const taskPicker = element("div", undefined, "draft-task-picker");
  taskPicker.hidden = true;
  const taskSearch = element("input");
  taskSearch.type = "search";
  const taskResults = element("div", undefined, "draft-task-results");
  taskPicker.append(taskSearch, taskResults);
  const menuItem = (glyph, onClick) => {
    const item = button("", onClick, "quiet draft-menu-item");
    item.append(icon(glyph), element("span"));
    return item;
  };
  const pickFiles = menuItem("file", () => {
    menu.hidePopover();
    picker.click();
  });
  const pickTasks = menuItem("tasklist", () => {
    menuActions.hidden = true;
    taskPicker.hidden = false;
    taskSearch.value = "";
    renderTaskResults();
    taskSearch.focus();
  });
  const pickGoal = menuItem("target", () => {
    menu.hidePopover();
    setGoalMode(!goalMode);
    input.focus();
  });
  menuActions.append(pickFiles, pickTasks, pickGoal);
  menu.append(menuHeading, menuActions, taskPicker);
  menu.addEventListener("beforetoggle", event => {
    if (event.newState !== "open") return;
    menuActions.hidden = false;
    taskPicker.hidden = true;
  });
  taskSearch.addEventListener("input", renderTaskResults);
  function findDraftTasks(query, limit) {
    query = query.trim().toLocaleLowerCase();
    const number = /^(?:t-)?(\d+)$/.exec(query)?.[1]?.replace(/^0+(?=\d)/, "");
    const tasks = [...(frame.board?.tasks ?? []), ...(frame.board?.archived ?? [])];
    if (number === undefined) return tasks.filter(task => (task.id + " " + task.title).toLocaleLowerCase().includes(query)).slice(0, limit);
    const shortId = task => task.id.slice(2).replace(/^0+(?=\d)/, "");
    const exact = tasks.filter(task => shortId(task) === number);
    const partial = tasks.filter(task => shortId(task) !== number && shortId(task).startsWith(number));
    return [...exact, ...partial].slice(0, limit);
  }
  function renderTaskResults() {
    const matches = findDraftTasks(taskSearch.value, 50);
    taskResults.replaceChildren(...matches.map(task => button(task.id + " · " + task.title, () => {
      menu.hidePopover();
      insertDraftText(task.id);
    }, "quiet draft-menu-item")));
    if (!matches.length) taskResults.append(element("p", () => t("ui.no_tasks_found_3f906b3d"), "draft-menu-heading muted"));
  }
  function insertDraftText(text, range) {
    const { start, end } = range ?? { start: input.selectionStart, end: input.selectionEnd };
    const leading = !range && start > 0 && /\S/.test(input.value[start - 1]) ? " " : "";
    const trailing = end === input.value.length || (!range && /\S/.test(input.value[end])) ? " " : "";
    input.setRangeText(leading + text + trailing, start, end, "end");
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const mentions = element("div", undefined, "draft-task-mentions draft-task-results");
  mentions.id = "board-task-mentions";
  mentions.popover = "manual";
  mentions.setAttribute("role", "listbox");
  let mention;
  let dismissedMention;
  let mentionIndex = 0;
  function closeMentions() {
    if (mentions.matches(":popover-open")) mentions.hidePopover();
    input.setAttribute("aria-controls", chat.id);
    input.removeAttribute("aria-activedescendant");
    mention = undefined;
  }
  editor.closeMentions = closeMentions;
  function highlightMention(index) {
    mentionIndex = index;
    for (const [i, option] of [...mentions.children].entries()) option.setAttribute("aria-selected", String(i === index));
    const option = mentions.children[index];
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }
  function syncMentions(event) {
    if (event?.isComposing || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return closeMentions();
    const caret = input.selectionStart;
    const match = /(?:^|[\s(\[{])(@(?:t-?)?\d*)$/i.exec(input.value.slice(0, caret));
    if (!match) {
      dismissedMention = undefined;
      closeMentions();
      return;
    }
    const start = caret - match[1].length;
    const suffix = /^(?:t-?)?\d*(?![\p{L}\p{N}_-])/iu.exec(input.value.slice(caret));
    if (!suffix) return closeMentions();
    const end = caret + suffix[0].length;
    const key = start + ":" + input.value.slice(start, end);
    if (key === mention?.key) return;
    if (key === dismissedMention) return closeMentions();
    dismissedMention = undefined;
    const tasks = findDraftTasks(input.value.slice(start + 1, end), 8);
    if (!tasks.length) return closeMentions();
    mention = { key, start, end, tasks };
    mentions.replaceChildren(...tasks.map((task, index) => {
      const option = element("div", task.id + " · " + task.title, "draft-menu-item draft-mention-option");
      option.id = mentions.id + "-" + index;
      option.setAttribute("role", "option");
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("click", () => chooseMention(index));
      return option;
    }));
    if (!mentions.matches(":popover-open")) mentions.showPopover();
    input.setAttribute("aria-controls", chat.id + " " + mentions.id);
    highlightMention(0);
  }
  function chooseMention(index) {
    if (!mention) return;
    const { start, end, tasks } = mention;
    closeMentions();
    insertDraftText(tasks[index].id, { start, end });
  }
  const microphone = button("", startDictation, "quiet draft-mic chat-mic");
  microphone.append(icon("mic"));
  const voiceRow = element("div", undefined, "draft-voice-row");
  const waveform = element("canvas", undefined, "draft-voice-wave");
  waveform.setAttribute("aria-hidden", "true");
  const cancelVoice = button("", () => endDictation(dictation, "", true), "quiet draft-voice-cancel");
  cancelVoice.append(icon("close"));
  const stopVoice = button("", () => stopDictation(dictation), "quiet draft-voice-stop");
  stopVoice.append(icon("debug-stop"));
  stopVoice.disabled = true;
  voiceRow.append(cancelVoice, waveform, stopVoice);
  voiceRow.addEventListener("keydown", event => {
    if (event.key === "Escape") endDictation(dictation, "", true);
  });
  voiceRow.hidden = true;
  const voiceStatus = element("p", undefined, "draft-voice-status muted");
  voiceStatus.setAttribute("role", "status");
  voiceStatus.hidden = true;
  function voiceMessage(text) {
    voiceStatus.textContent = text;
    voiceStatus.hidden = !text;
  }
  function releaseMicrophone(recording) {
    clearTimeout(recording.timeout);
    cancelAnimationFrame(recording.animation);
    recording.stream?.getTracks().forEach(track => track.stop());
    recording.stream = undefined;
    if (recording.audio?.state !== "closed") void recording.audio?.close().catch(() => {});
    recording.audio = undefined;
  }
  function endDictation(recording, text = "", focus = false) {
    if (!recording || dictation !== recording) return;
    dictation = undefined;
    if (recording.windowsSpeech) void api.windowsSpeech("cancel").catch(() => {});
    if (recording.recorder?.state === "recording") recording.recorder.stop();
    releaseMicrophone(recording);
    editor.removeAttribute("data-dictating");
    stopVoice.disabled = true;
    voiceRow.hidden = true;
    voiceMessage(text);
    if (focus && editor.isConnected) input.focus({ preventScroll: true });
  }
  editor.cancelDictation = () => endDictation(dictation);
  function stopDictation(recording) {
    if (recording !== dictation || recording?.recorder?.state !== "recording") return;
    stopVoice.disabled = true;
    if (recording.windowsSpeech) recording.windowsText = api.windowsSpeech("stop").catch(() => undefined);
    if (document.activeElement === stopVoice) cancelVoice.focus({ preventScroll: true });
    recording.recorder.stop();
    voiceMessage(t("ui.transcribing_b8676524"));
  }
  function drawWaveform(recording, analyser) {
    const context = waveform.getContext("2d");
    const levels = new Uint8Array(analyser.fftSize);
    const history = [];
    let lastSample = -Infinity;
    const draw = now => {
      const width = waveform.clientWidth;
      const height = waveform.clientHeight;
      const scale = devicePixelRatio;
      if (waveform.width !== Math.round(width * scale) || waveform.height !== Math.round(height * scale)) {
        waveform.width = Math.round(width * scale);
        waveform.height = Math.round(height * scale);
      }
      const bars = Math.floor(width / 5);
      if (now - lastSample >= 35) {
        analyser.getByteTimeDomainData(levels);
        const rms = Math.sqrt(levels.reduce((sum, level) => sum + ((level - 128) / 128) ** 2, 0) / levels.length);
        history.push(rms);
        lastSample = now;
      }
      if (history.length > bars) history.splice(0, history.length - bars);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(waveform).color;
      for (let index = 0; index < bars; index++) {
        const level = history[history.length - bars + index] ?? 0;
        const size = Math.min(height, 2 + level * height * 5);
        context.fillRect(index * 5, (height - size) / 2, 2, size);
      }
      recording.animation = requestAnimationFrame(draw);
    };
    recording.animation = requestAnimationFrame(draw);
  }
  async function finishDictation(recording, chunks) {
    if (recording !== dictation) return;
    if (recording.windowsSpeech && !recording.windowsText) {
      recording.windowsText = api.windowsSpeech("stop").catch(() => undefined);
    }
    releaseMicrophone(recording);
    stopVoice.disabled = true;
    voiceMessage(t("ui.transcribing_b8676524"));
    const noSpeech = t("ui.no_speech_detected_42e47e09");
    const failed = t("ui.could_not_transcribe_the_recording_140782e0");
    try {
      const nativeText = await recording.windowsText;
      if (recording !== dictation) return;
      if (nativeText) {
        endDictation(recording, "", true);
        insertDraftText(nativeText);
        return;
      }
      if (!chunks.length) return endDictation(recording, noSpeech, true);
      const decoder = new OfflineAudioContext(1, 1, 16_000);
      const audio = await decoder.decodeAudioData(await new Blob(chunks, { type: recording.recorder.mimeType }).arrayBuffer());
      if (recording !== dictation) return;
      const mix = new OfflineAudioContext(1, audio.length, 16_000);
      const source = mix.createBufferSource();
      source.buffer = audio;
      source.connect(mix.destination);
      source.start();
      const samples = (await mix.startRendering()).getChannelData(0);
      if (recording !== dictation) return;
      if (!samples.some(sample => Math.abs(sample) > .004)) return endDictation(recording, noSpeech, true);
      const result = await api.transcribeVoice(samples, recording.language);
      if (recording !== dictation) return;
      if (!result.ok) return endDictation(recording, boardError(result.error), true);
      endDictation(recording, result.data ? "" : noSpeech, true);
      if (result.data) insertDraftText(result.data);
    } catch {
      endDictation(recording, failed, true);
    }
  }
  async function startDictation() {
    if (dictation) return;
    if (!["en", "ru"].includes(localization.locale)) { message(t("speech.unsupported")); return; }
    const recording = { language: localization.locale };
    dictation = recording;
    closeMentions();
    voiceRow.hidden = false;
    stopVoice.disabled = true;
    editor.setAttribute("data-dictating", "");
    cancelVoice.focus({ preventScroll: true });
    voiceMessage(t("ui.opening_microphone_fc24ba14"));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (dictation !== recording) return stream.getTracks().forEach(track => track.stop());
      recording.stream = stream;
      const recorder = recording.recorder = new MediaRecorder(stream);
      const audio = recording.audio = new AudioContext();
      void audio.resume().catch(() => {});
      const analyser = audio.createAnalyser();
      audio.createMediaStreamSource(stream).connect(analyser);
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => { void finishDictation(recording, chunks); };
      recorder.onerror = () => endDictation(recording,
        t("ui.microphone_recording_failed_75d7cfdd"), true);
      recorder.start();
      if (api.isWindows && api.windowsSpeech) {
        recording.windowsSpeech = true;
        void api.windowsSpeech("start", recording.language).catch(() => {});
      }
      stopVoice.disabled = false;
      stopVoice.focus({ preventScroll: true });
      voiceMessage(t("ui.recording_c802bab3"));
      drawWaveform(recording, analyser);
      recording.timeout = setTimeout(() => stopDictation(recording), 120_000);
    } catch {
      endDictation(recording, t("ui.could_not_access_the_microphone_check_your_devic_60f388b4"), true);
    }
  }
  const goalChip = button("", () => {
    setGoalMode(false);
    input.focus();
  }, "quiet draft-goal-chip");
  const goalLabel = element("span");
  goalChip.append(icon("target"), goalLabel, icon("close"));
  const send = element("button", undefined, "button primary draft-send chat-send");
  send.type = "button";
  send.addEventListener("click", () => {
    if (hasDraft()) {
      editor.requestSubmit();
      return;
    }
    if (active && canStop && !stopping) void stopReply();
  });
  async function stopReply() {
    const request = active;
    stopping = true;
    syncAction();
    try {
      const result = await api.stopOrchestrator();
      if (!result.ok) throw new Error(boardError(result.error));
    } catch (error) {
      if (active !== request) return;
      stopping = false;
      syncAction();
      message(error.message);
    }
  }
  controls.append(microphone, send);
  const attachments = element("ul", undefined, "draft-attachments board-attachments");
  attachments.hidden = true;
  const progress = element("p", undefined, "draft-progress muted");
  progress.hidden = true;
  progress.setAttribute("role", "status");
  const syncPrompt = () => {
    const status = !editor.matches("[data-open], [data-pinned]") && (active?.thinking.textContent || (managerWork &&
      (managerWork.lane === "maintenance" ? t("ui.checking_worktree_cleanup_1f82f9a8") : runningLabel(managerWork.item).status)));
    const text = status || t(goalMode ? "ui.describe_the_goal_79e3a385" : "ui.write_to_the_project_manager_49756120");
    if (prompt.textContent !== text) prompt.textContent = text;
    input.setAttribute("aria-label", t(goalMode ? "ui.describe_the_goal_79e3a385" : "ui.message_the_project_manager_247ec40b"));
  };
  editor.syncPrompt = syncPrompt;
  const hasDraft = () => Boolean(input.value.trim() || quotes.length || (!goalMode && files.length));
  function setGoalMode(value) {
    goalMode = value;
    goalChip.hidden = !value;
    pickGoal.setAttribute("aria-pressed", String(value));
    syncPrompt();
    syncAction();
  }
  const syncAction = () => {
    const stop = Boolean(active) && !hasDraft();
    syncChatActionIcon(send, stop);
    send.disabled = stop ? !canStop || stopping : goalMode && !hasDraft();
    controlLabelForIcon(send, () => stop ? (waitingForChat ? t("ui.cancel_sending_480e1dd5") :
      t("ui.stop_reply_fc199c8c")) : t("ui.send_request_b9ccf5ac"));
  };
  editor.localize = () => {
    syncPrompt();
    updatePin();
    bindLocalized(dialogueToggle, "textContent", () => t("ui.dialogue_e154ab04"));
    bindLocalized(unreadDivider, "textContent", () => t("ui.new_messages_bb42ec76"));
    bindLocalized(workToggle, "textContent", () => t("ui.goal_activity"));
    work.setAttribute("aria-label", workToggle.textContent);
    bindLocalized(workOlder, "textContent", () => t("ui.earlier_activity_e8606f75"));
    bindLocalized(goalText, "aria-label", () => t("ui.goal_objective_c057a817"), true);
    bindLocalized(saveGoal, "textContent", () => t("ui.save_changes_c6c74561"));
    bindLocalized(pauseGoal, "textContent", () => t("ui.pause_2541bca6"));
    bindLocalized(resumeGoal, "textContent", () => t("ui.resume_b9681b5e"));
    bindLocalized(clearGoal, "textContent", () => t("ui.clear_goal_a38efd6d"));
    syncGoal();
    bindLocalized(chat, "aria-label", () => t("ui.project_manager_chat_a425db31"), true);
    bindLocalized(resize, "aria-label", () => t("ui.chat_height_145da15f"), true);
    bindLocalized(greeting, "textContent", () => t("ui.ask_about_the_project_or_discuss_what_needs_to_c_b07dfce4"));
    bindLocalized(queue, "aria-label", () => t("ui.message_queue_e8b641b1"), true);
    bindLocalized(olderHistory, "textContent", () => t("ui.load_older_messages_72d1e9d5"));
    bindLocalized(hint, "textContent", () => t("ui.paste_or_attach_files_88444059") + (api.isMac ? " (⌘V)." : " (Ctrl+V)."));
    controlLabelForIcon(add, () => t("ui.add_to_message_974fafaa"));
    controlLabelForIcon(microphone, () => t("ui.voice_input_a05b7480"));
    controlLabelForIcon(cancelVoice, () => t("ui.cancel_recording_4dcdab42"));
    controlLabelForIcon(stopVoice, () => t("ui.stop_and_transcribe_0b723821"));
    bindLocalized(menuHeading, "textContent", () => t("ui.add_1e41c69d"));
    bindLocalized(pickFiles.lastElementChild, "textContent", () => t("ui.files_8f8e0a0c"));
    bindLocalized(pickTasks.lastElementChild, "textContent", () => t("ui.tasks_ee4354d6"));
    bindLocalized(pickGoal.lastElementChild, "textContent", () => goalLabel.textContent = t("ui.goal_mode_a3ba3229"));
    controlLabelForIcon(goalChip, () => t("ui.exit_goal_mode_199fc93b"));
    bindLocalized(taskSearch, "placeholder", () => t("ui.find_a_task_b0398552"));
    taskSearch.setAttribute("aria-label", taskSearch.placeholder);
    bindLocalized(mentions, "aria-label", () => t("ui.task_suggestions_3d8854b7"), true);
    syncAction();
    bindLocalized(attachments, "aria-label", () => t("ui.attachments_3b2db3b4"), true);
  };
  editor.localize();
  setGoalMode(false);
  const field = element("div", undefined, "board-draft-field");
  const quoteDraft = chatQuoteDraft({
    panel: editor,
    input,
    logs: [log, work],
    quotes,
    locked: () => savingQueuedMessage,
    changed: syncAction,
    focusComposer: () => {
      openChat();
      showWork(false);
      input.focus();
    },
  });
  editor.closeQuoteEditor = quoteDraft.close;
  let question;
  let questionDialog;
  let shownQuestionId;
  const openQuestion = () => {
    if (question && !questionDialog?.open) questionDialog = managerQuestionDialog(question, answer);
  };
  const answer = button("", openQuestion, "quiet manager-question-trigger");
  editor.closeQuestion = () => { if (questionDialog?.open) questionDialog.close(); };
  editor.updateQuestion = next => {
    if (question?.id !== next?.id) editor.closeQuestion();
    question = next;
    answer.hidden = !next;
    bindLocalized(answer, "textContent", () => next?.approval ? t("ui.review_access_request_f6325f6e") :
      t("ui.answer_the_manager_be5b6afe"));
    if (next && shownQuestionId !== next.id && editor.isConnected) {
      shownQuestionId = next.id;
      openQuestion();
    }
  };
  editor.updateQuestion(undefined);
  const inputArea = element("div", undefined, "draft-input");
  inputArea.append(input, prompt);
  field.append(quoteDraft.root, add, inputArea, controls, voiceRow, menu, mentions, picker, hint, goalChip, attachments, voiceStatus, progress);
  field.append(answer);
  editor.append(chat, field);
  const previewImages = (images, file) => openImagePreview(undefined, images, images.indexOf(file), file.url, {
    preview: image => image.url,
    save: image => {
      const link = element("a");
      link.href = image.url;
      link.download = image.name;
      link.click();
      return { ok: true };
    },
  });
  const chatMessage = (actor, text, files = [], animate = false, insert = true, clientId, at) => {
    greeting.hidden = true;
    const entry = element("div", undefined, "chat-entry");
    entry.dataset.actor = actor;
    if (actor === "user") entry.dataset.chatAnchor = "user:" + (clientId ?? JSON.stringify([text, files.map(file => file.name)]));
    if (actor === "agent") entry.classList.add("board-manager-message");
    entry.toggleAttribute("data-enter", animate);
    if (files.length) {
      const tiles = element("div", undefined, "chat-attachments");
      const images = files.filter(file => file.url);
      for (const file of files) {
        const tile = file.url ? button("", () => previewImages(images, file), "quiet chat-attachment") :
          file.link ? button("", async () => {
            const result = await api.openFileLink(file.link);
            if (!result.ok) message(boardError(result.error));
          }, "quiet chat-attachment") : element("span", undefined, "chat-attachment");
        if (file.link) tile.title = file.link.path;
        if (file.url) {
          controlLabelForIcon(tile, () => t("ui.view_7aa05de3") + file.name);
          const img = element("img");
          img.alt = file.name;
          img.loading = "lazy";
          img.src = file.url;
          tile.append(img);
        } else tile.append(icon("attachment"), element("span", file.name + (file.size !== undefined ? " / " + file.size + " B" : "")));
        tiles.append(tile);
      }
      entry.append(tiles);
    }
    if (text) {
      const message = actor === "agent" ? chatText(text, { agent: true }) : element("p", text, "chat-text");
      if (actor !== "agent") showHexColors(message, true);
      entry.append(message);
    }
    appendChatTime(entry, at);
    if (insert) log.append(entry);
    return entry;
  };
  let reviewErrorTask;
  const message = text => {
    reviewErrorTask = undefined;
    progress.textContent = text;
    progress.hidden = !text;
  };
  editor.reviewError = (error, id) => {
    if (error) {
      message(t("ui.automatic_review_was_interrupted_2fded29c") + "\n" + error);
      reviewErrorTask = id;
    } else if (id && id === reviewErrorTask) message("");
  };
  const busy = value => {
    syncPrompt();
    editor.setAttribute("aria-busy", String(value));
    waitingForChat = false;
    canStop = stopping = false;
    syncAction();
  };
  editor.enableStop = () => {
    if (!active) return;
    canStop = true;
    syncAction();
  };
  const thinkingLabel = () => t("ui.thinking_14a886f3");
  const waitingLabel = () => t("ui.waiting_for_the_codex_chat_to_become_available_ddb2e85f");
  const showActivityStatus = (text, command = false) => {
    const label = active.thinking.firstElementChild;
    if (label.textContent === text && Boolean(label.querySelector(".codicon-terminal")) === command) return;
    label.replaceChildren(element("span", text, "chat-thinking-text"));
    if (command) label.prepend(icon("terminal"));
    syncPrompt();
    if (!reducedMotion.matches) {
      active.statusAnimation?.cancel();
      active.statusAnimation = label.animate([{ opacity: .35, transform: "translateY(2px)" }, { opacity: 1, transform: "translateY(0)" }], {
        duration: 180, easing: "ease-out",
      });
    }
  };
  editor.setWaiting = waiting => {
    if (!active) return;
    waitingForChat = waiting;
    showActivityStatus(waiting ? waitingLabel() : thinkingLabel());
    canStop = waiting;
    syncAction();
  };
  const seenMessages = new Set();
  const rememberMessages = container => {
    for (const entry of container.querySelectorAll("[data-coordination-key]")) {
      seenMessages.add(entry.dataset.coordinationKey);
    }
  };
  const streamedText = new WeakMap();
  const fadeDuration = 240;
  const fadeStreamedText = (block, previous, now) => {
    const text = block.textContent.trimEnd();
    const oldText = previous?.text ?? "";
    let shared = 0;
    while (shared < oldText.length && text[shared] === oldText[shared]) shared++;
    const ranges = (previous?.ranges ?? []).filter(range => range.end <= shared && now - range.startTime < fadeDuration);
    // Markdown can reformat earlier characters when a closing delimiter arrives.
    const start = Math.max(shared, Math.min(oldText.length, text.length));
    if (start < text.length) ranges.push({ start, end: text.length, startTime: now });
    streamedText.set(block, { text, ranges });
    if (!ranges.length || reducedMotion.matches) return;

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let offset = 0;
    let index = 0;
    for (const node of nodes) {
      if (!node.length) continue;
      const end = offset + node.length;
      let tail = node;
      while (index < ranges.length && ranges[index].start < end) {
        const range = ranges[index];
        const left = Math.max(offset, range.start);
        const right = Math.min(end, range.end);
        if (left > offset) tail = tail.splitText(left - offset);
        const span = element("span", undefined, "chat-stream-fragment");
        span.style.animationDelay = (range.startTime - now) + "ms";
        const rest = right < end ? tail.splitText(right - left) : null;
        tail.before(span);
        span.append(tail);
        offset = right;
        tail = rest;
        if (right === range.end) index++;
        if (!tail) break;
      }
      offset = end;
    }
  };
  const renderActivity = (container, items, completed, context = { dialogue: true, seenMessages }) => {
    const messages = new Map();
    for (const child of container.querySelectorAll("[data-item]")) {
      const block = child.matches(".chat-text") ? child : child.matches(".chat-run-final, .board-manager-message") ? child.firstElementChild : undefined;
      const state = block && streamedText.get(block);
      if (state) messages.set(activityRowKey(child.dataset.item), state);
    }
    const previous = new Map([...container.querySelectorAll("[data-item]")].map(child =>
      [activityRowKey(child.dataset.item), child.getAnimations().find(animation => animation.animationName === "board-chat-enter")?.currentTime]));
    renderRunActivity(container, items, completed, undefined, undefined, {
      ...context, userMessage: ({ text, files, at }, id) => chatMessage("user", text, files, false, false, context.managerWork ? id : undefined, at),
    });
    if (completed && context.dialogue) rememberMessages(container);
    const now = performance.now();
    for (const child of container.querySelectorAll("[data-item]")) {
      const key = activityRowKey(child.dataset.item);
      if (child.matches(".chat-text, .chat-run-final, .board-manager-message")) {
        const block = child.matches(".chat-text") ? child : child.firstElementChild;
        if (messages.has(key)) fadeStreamedText(block, messages.get(key), now);
        else streamedText.set(block, { text: block.textContent.trimEnd(), ranges: [] });
      }
      if (child.parentElement.closest("[data-enter]")) continue;
      const elapsed = previous.get(key);
      if (previous.has(key) && !(elapsed >= 0 && elapsed < 220)) continue;
      child.setAttribute("data-enter", "");
      const animation = child.getAnimations()[0];
      if (animation && elapsed != null) animation.currentTime = elapsed;
    }
  };
  let loadingHistory;
  let historyLoaded = false;
  let hasDialogueHistory = false;
  let historyInvalidated = false;
  let reloadAfterHistory = false;
  let loadingOlder = false;
  let historyGeneration = 0;
  let recentCursor;
  let olderCursor;
  let lastScrollTop = 0;
  const olderNodes = [];
  const olderPages = [];
  const historyMarkup = new WeakMap();
  const historyRuns = new WeakMap();
  const historyRunHeights = new WeakMap();
  let savedLogWidth;
  let recentTurns;
  let recentNodes = [];
  let historyUnmounted = false;
  const previewUrls = [];
  const pendingPreviews = new Map();
  const previewSource = file => !file.link && file.size <= 64 * 1024 * 1024 && (/^(?:image\/(?:png|jpeg|webp|gif))$/.test(file.type) || isImageAttachment(file));
  const releasePreview = file => {
    const url = pendingPreviews.get(file);
    if (url) URL.revokeObjectURL(url);
    pendingPreviews.delete(file);
  };
  const releaseSubmittedPreviews = submitted => {
    for (const file of submitted) {
      if (!files.includes(file) && !queued.some(job => job.submitted.includes(file))) releasePreview(file);
    }
  };
  const releaseMessagePreviews = messageFiles => {
    for (const { url } of messageFiles) {
      const index = previewUrls.indexOf(url);
      if (index === -1) continue;
      URL.revokeObjectURL(url);
      previewUrls.splice(index, 1);
    }
  };
  editor.dispose = () => {
    disposed = true;
    quoteDraft.close();
    clearTimeout(readRetry);
    cancelAnimationFrame(readFrame);
    readObserver.disconnect();
    dialogueViewport.dispose();
    workViewport.dispose();
    editor.closeQuestion();
    editor.cancelDictation();
    queued.length = 0;
    for (const url of previewUrls.splice(0)) URL.revokeObjectURL(url);
    for (const file of pendingPreviews.keys()) releasePreview(file);
  };
  function renderHistoryPage(turns, reuseHeights = false) {
    const page = document.createDocumentFragment();
    const delivered = new Set();
    const liveIds = new Set(active?.items?.map(item => item.id));
    let markdownCache = historyMarkup.get(turns);
    if (!markdownCache) {
      // Save the formatted markup for remounts without holding on to rendered nodes.
      markdownCache = new Map();
      historyMarkup.set(turns, markdownCache);
    }
    for (const turn of turns) {
      for (const { text, files, clientId, at } of turn.messages) {
        if (clientId && (active?.id === clientId || liveIds.has(clientId))) continue;
        page.append(chatMessage("user", text, files, false, false, clientId, at));
        if (clientId) delivered.add(clientId);
      }
      const container = element("div", undefined, "chat-run");
      renderRunActivity(container, turn.items.filter(item => !liveIds.has(item.id)), true, turn.durationMs, undefined,
        { dialogue: true, seenMessages, markdownCache });
      rememberMessages(container);
      if (!container.hidden) {
        historyRuns.set(container, turn);
        const height = reuseHeights ? historyRunHeights.get(turn) : undefined;
        if (height) {
          container.style.contentVisibility = "auto";
          container.style.containIntrinsicBlockSize = "auto " + height + "px";
        }
        page.append(container);
      }
    }
    return { page, delivered };
  }
  const atEndOfHistory = dialogueViewport.atEnd;
  const canBrowseHistory = () => editor.isConnected && editor.matches("[data-open], [data-pinned]");
  function updateOlderHistory() {
    olderHistory.hidden = !olderCursor;
    olderHistory.disabled = loadingOlder;
  }
  function forgetOlderHistory() {
    historyGeneration++;
    for (const node of olderNodes.splice(0)) node.remove();
    olderPages.length = 0;
    olderCursor = recentCursor;
    seenMessages.clear();
    rememberMessages(log);
    updateOlderHistory();
  }
  async function loadOlderHistory(allowWhileOpening = false) {
    if (disposed || !olderCursor || (loadingHistory && !allowWhileOpening) || loadingOlder || !canBrowseHistory()) return;
    const cursor = olderCursor;
    const generation = historyGeneration;
    loadingOlder = true;
    updateOlderHistory();
    try {
      const result = await api.boardHistory(project, cursor);
      if (disposed || generation !== historyGeneration || !canBrowseHistory()) return;
      if (!result.ok) throw new Error(boardError(result.error));
      dialogueViewport.update(() => {
        const { page } = renderHistoryPage(result.data.turns);
        olderPages.push(result.data.turns);
        olderNodes.push(...page.children);
        greeting.after(page);
        updateUnreadMessages();
        olderCursor = result.data.nextCursor === cursor ? null : result.data.nextCursor;
        updateOlderHistory();
        greeting.hidden = log.childElementCount > 2;
      });
      lastScrollTop = log.scrollTop;
    } catch (error) {
      if (!disposed && generation === historyGeneration) message(error.message);
    } finally {
      loadingOlder = false;
      updateOlderHistory();
    }
  }
  async function refreshGoalAvailability() {
    const revision = ++goalAvailabilityRevision;
    try {
      const result = await api.boardHistory(project, null, "goal-availability");
      if (!disposed && revision === goalAvailabilityRevision && result.ok && typeof result.data === "boolean") {
        goalLogAvailable = result.data;
        syncViews();
        syncPrompt();
      }
    } catch {
      // A failed availability check leaves the last known state in place.
    }
  }

  const loadHistory = () => {
    if (!historyLoaded && !loadingHistory) {
      const revision = goalRevision;
      loadingHistory = api.boardHistory(project).then(async result => {
        if (!result.ok) throw new Error(boardError(result.error));
        if (disposed || reloadAfterHistory || !canBrowseHistory()) return;
        if (revision === goalRevision) editor.updateGoal(result.data.goal, result.data.goalRunning, result.data.goalResuming, result.data);
        void refreshGoalAvailability();
        const oldImages = [...log.querySelectorAll(".chat-attachments img")];
        let delivered;
        dialogueViewport.update(() => {
          const previousReplies = new Set([...log.querySelectorAll("[data-message-id], .board-manager-message[data-item]")].map(node =>
            node.dataset.messageId ?? node.dataset.item.slice("message:".length)));
          historyGeneration++;
          olderNodes.length = 0;
          olderPages.length = 0;
          recentTurns = result.data.turns;
          recentCursor = olderCursor = result.data.nextCursor;
          seenMessages.clear();
          const next = renderHistoryPage(recentTurns);
          recentNodes = [...next.page.children];
          historyUnmounted = false;
          delivered = next.delivered;
          if (hasDialogueHistory) for (const reply of next.page.querySelectorAll("[data-message-id]")) {
            if (!previousReplies.has(reply.dataset.messageId)) reply.setAttribute("data-enter", "");
          }
          log.replaceChildren(olderHistory, greeting, next.page);
          if (active?.entry) log.append(active.entry);
          if (active) log.append(active.container, active.thinking);
          updateOlderHistory();
          greeting.hidden = log.childElementCount > 2;
          updateUnreadMessages();
        });
        await restoreQueue().catch(() => {});
        for (const job of [...queued]) {
          if (!delivered.has(job.id) || job.sending) continue;
          await queueStorage("remove", job.id);
          if (disposed || !queued.includes(job)) continue;
          queued.splice(queued.indexOf(job), 1);
          job.row.remove();
          releaseMessagePreviews(job.messageFiles);
          releaseSubmittedPreviews(job.submitted);
        }
        releaseMessagePreviews(oldImages.filter(image => !log.contains(image)).map(image => ({ url: image.src })));
        if (!disposed) {
          historyLoaded = true;
          if (!hasDialogueHistory) {
            hasDialogueHistory = true;
            while (unread.size && olderCursor && canBrowseHistory() && !log.hidden) {
              const shown = log.querySelectorAll('.board-manager-message[data-read="false"]').length;
              if (shown >= unread.size) break;
              const cursor = olderCursor;
              await loadOlderHistory(true);
              if (cursor === olderCursor) break;
            }
            positionNewDialogue = true;
          }
          requestAnimationFrame(showDialoguePosition);
        }
      }).finally(() => {
        loadingHistory = undefined;
        if (reloadAfterHistory && !disposed) {
          reloadAfterHistory = false;
          editor.invalidateHistory();
        }
      });
    }
    return loadingHistory;
  };
  const revealHistory = () => {
    const remounting = historyUnmounted;
    if (historyUnmounted && historyInvalidated && atEndOfHistory()) {
      historyInvalidated = false;
      historyLoaded = false;
    }
    readObserver.observe(log);
    dialogueViewport.resume(() => {
      if (!historyUnmounted) return;
      historyUnmounted = false;
      const reuseHeights = log.clientWidth === savedLogWidth;
      // Keep the reading anchor until the saved pages are back in the viewport.
      const { page } = renderHistoryPage(recentTurns, reuseHeights);
      recentNodes = [...page.children];
      greeting.after(page);
      for (const turns of olderPages) {
        const { page } = renderHistoryPage(turns, reuseHeights);
        olderNodes.push(...page.children);
        greeting.after(page);
      }
      greeting.hidden = log.childElementCount > 2;
      updateUnreadMessages();
    });
    lastScrollTop = log.scrollTop;
    if (historyLoaded && !remounting) {
      dialogueViewport.restore();
      dialogueViewport.update(updateUnreadMessages);
    }
    void restoreQueue().catch(() => {});
    void loadHistory()?.catch(error => message(error.message));
    if (active?.shared && !active.items.length) refreshDialogue(active);
  };
  const openChat = () => {
    if (editor.hasAttribute("data-open") && (historyLoaded || loadingHistory)) return;
    editor.toggleAttribute("data-chat-remount", historyUnmounted);
    editor.setAttribute("data-open", "");
    syncPrompt();
    revealHistory();
    workViewport.resume(() => {
      if (savedWork.length || liveWork.length || pendingWork.size) renderGoalTimeline();
    });
    if (!work.hidden) editor.invalidateWork();
  };
  editor.closeChat = () => {
    if (pinned || !editor.hasAttribute("data-open")) return;
    quoteDraft.close();
    clearTimeout(readRetry);
    cancelAnimationFrame(readFrame);
    readFrame = undefined;
    readObserver.disconnect();
    historyGeneration++;
    const removeHistory = node => {
      for (const tile of node.querySelectorAll(".chat-attachment")) chatPreviews.unobserve(tile);
      node.remove();
    };
    const removed = [...recentNodes, ...olderNodes, ...workTimeline.children];
    if (!log.hidden) {
      savedLogWidth = log.clientWidth;
      for (const node of [...recentNodes, ...olderNodes]) {
        const turn = historyRuns.get(node);
        if (turn) historyRunHeights.set(turn, node.getBoundingClientRect().height);
      }
    }
    dialogueViewport.suspend(() => {
      unreadDivider.remove();
      for (const node of recentNodes) removeHistory(node);
      for (const node of olderNodes) removeHistory(node);
      recentNodes = [];
      olderNodes.length = 0;
      historyUnmounted = Boolean(recentTurns);
      seenMessages.clear();
      rememberMessages(log);
    });
    workViewport.suspend(() => {
      for (const node of [...workTimeline.children]) removeHistory(node);
    });
    for (const binding of localizedBindings) {
      if (!binding.node.isConnected && removed.some(node => node.contains(binding.node))) localizedBindings.delete(binding);
    }
    editor.removeAttribute("data-open");
    editor.removeAttribute("data-chat-remount");
    syncPrompt();
  };
  editor.revealPinned = () => { if (pinned && !loadingHistory && !historyLoaded) revealHistory(); };
  editor.invalidateHistory = () => {
    if (loadingHistory) {
      reloadAfterHistory = true;
      return;
    }
    if (historyLoaded && !atEndOfHistory() && (olderPages.length || loadingOlder)) {
      historyInvalidated = true;
      return;
    }
    historyInvalidated = false;
    historyLoaded = false;
    if (editor.matches("[data-open], [data-pinned]")) revealHistory();
  };
  log.addEventListener("scroll", () => {
    const top = log.scrollTop;
    const previous = lastScrollTop;
    lastScrollTop = top;
    if (!canBrowseHistory()) return;
    readVisibleMessages();
    if (top < previous && top <= 100) void loadOlderHistory();
    if (top > previous && atEndOfHistory()) {
      if (loadingOlder || olderNodes.length || olderCursor !== recentCursor) {
        dialogueViewport.update(forgetOlderHistory);
        lastScrollTop = log.scrollTop;
      }
      if (historyInvalidated && !active) editor.invalidateHistory();
    }
  });
  log.addEventListener("wheel", event => {
    if (event.deltaY < 0 && log.scrollTop === 0) void loadOlderHistory();
  }, { passive: true });
  field.addEventListener("click", event => {
    if (dictation || event.target.closest(".draft-controls, .draft-add, .draft-add-menu, .draft-task-mentions, .draft-goal-chip, .draft-attachments, .draft-progress, .chat-quote-draft")) return;
    openChat();
    if (event.target !== input) input.focus({ preventScroll: true });
  });
  for (const event of ["input", "focus", "blur"]) input.addEventListener(event, syncPrompt);
  input.addEventListener("input", syncAction);
  for (const event of ["input", "select", "click", "compositionend"]) input.addEventListener(event, syncMentions);
  input.addEventListener("blur", closeMentions);
  const renderTurn = (turn, items, completed) => {
    turn.items = items;
    const timeline = turn.deliveries.size ? [...items] : items;
    // A delivery can replace the local bubble, but must follow activity already shown at send time.
    for (const [id, delivery] of turn.deliveries) {
      const index = timeline.findIndex(item => item.userMessage && item.id === id);
      if (index !== -1 && delivery.fallback) {
        releaseMessagePreviews(delivery.fallback.userMessage.files);
        delivery.fallback = undefined;
      }
      const after = timeline.findIndex(item => item.id === delivery.after);
      if (index === -1 && delivery.fallback) {
        timeline.splice(after + 1, 0, delivery.fallback);
      } else if (index !== -1 && index < after) {
        const [item] = timeline.splice(index, 1);
        timeline.splice(after, 0, item);
      }
    }
    turn.lastItem = timeline.at(-1)?.id;
    renderActivity(turn.container, completed ? timeline :
      timeline.filter(item => item.type !== "reasoning" || item.status !== "inProgress"), completed);
  };
  function runningLabel(running) {
    let status = thinkingLabel();
    let command = false;
    const boardWait = boardWaitStatus(running);
    if (boardWait) {
      status = boardWait;
    } else if (running?.type === "reasoning") {
      // Codex sends Markdown headings in its public reasoning summaries.
      const headings = [...running.text.matchAll(/^[ \t]*(?:\*\*([^*\r\n]{1,160})\*\*|#{1,6}[ \t]+([^\r\n]{1,160}))[ \t]*$/gm)];
      const heading = headings.at(-1);
      status = (heading?.[1] ?? heading?.[2])?.trim() || status;
    } else if (running?.type === "agentMessage") {
      status = t("ui.writing_a_reply_c232bd87");
    } else if (running?.type === "plan") {
      status = t("ui.planning_d116e766");
    } else if (running?.type === "autoApprovalReview") {
      status = t("ui.reviewing_access_90d4aaaf");
    } else if (running) {
      const kind = activityKind(running);
      const title = (kind === "command" ? readableRunCommand(running.title) : running.title).replace(/\s+/g, " ").trim();
      const labels = {
        command: ["ui.running_a_command_012642be"],
        edit: ["ui.editing_files_9cbb7893"],
        image: ["ui.working_with_an_image_a130279c"],
        search: ["ui.searching_the_web_340a4266"],
        tool: ["ui.using_a_tool_fb94a28b"],
      };
      const detailed = {
        command: ["ui.running_1d0aaf75"],
        search: ["ui.searching_the_web_09f32915"],
        tool: ["ui.using_tool_626395f5"],
      };
      status = title && detailed[kind] ? t(...detailed[kind]) + title : t(...labels[kind]);
      command = kind === "command";
    }
    return { status, command };
  }
  function showRunningItem(running) {
    if (waitingForChat) return;
    const { status, command } = runningLabel(running);
    showActivityStatus(status, command);
  }
  editor.setMessageTime = at => {
    if (active?.entry && !active.entry.querySelector(".chat-time")) dialogueViewport.update(() => appendChatTime(active.entry, at));
  };
  editor.updateActivity = items => {
    if (!active) return;
    dialogueViewport.update(() => {
      showRunningItem(items.findLast(item => item.status === "inProgress"));
      renderTurn(active, items, false);
      updateUnreadMessages();
    });
    readVisibleMessages();
  };
  function refreshDialogue(turn) {
    void api.boardHistory(project, null, "live").then(result => {
      if (!disposed && result.ok && active === turn && !turn.items.length) editor.updateActivity(result.data.dialogue ?? []);
    }).catch(() => {});
  }
  const pasteFiles = submitted => Promise.all(submitted.map(file => api.filePayload(file)));
  const queueStorage = async (action, id, draft, goal, attachments) => {
    const result = await api.boardQueue(project, action, id, draft, goal, attachments);
    if (!result.ok) throw new Error(boardError(result.error));
    return result.data;
  };
  let restoredQueue;
  let refreshingQueue = false;
  let queueChanged = false;
  let movingQueue = false;
  let draggedJob;
  let dropRow;
  const canMove = job => !job.goal && !job.editing && !job.sending && !job.inFlight && queued.includes(job);
  function clearQueueDrop() {
    dropRow?.removeAttribute("data-queue-drop");
    dropRow = undefined;
  }
  function queueDropTarget(event) {
    const row = event.target.closest(".board-queued-row");
    const target = queued.find(job => job.row === row);
    if (!draggedJob || !canMove(draggedJob) || !target || target === draggedJob || !canMove(target)) return;
    const bounds = row.getBoundingClientRect();
    return { target, after: event.clientY >= bounds.top + bounds.height / 2 };
  }
  queue.addEventListener("dragover", event => {
    clearQueueDrop();
    const drop = queueDropTarget(event);
    if (!drop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dropRow = drop.target.row;
    dropRow.dataset.queueDrop = drop.after ? "after" : "before";
  });
  queue.addEventListener("dragleave", event => {
    if (!queue.contains(event.relatedTarget)) clearQueueDrop();
  });
  queue.addEventListener("drop", event => {
    const drop = queueDropTarget(event);
    clearQueueDrop();
    if (!drop) return;
    event.preventDefault();
    void moveQueueJob(draggedJob, drop.target, drop.after);
  });
  async function moveQueueJob(job, target, after) {
    if (disposed || movingQueue || !canMove(job) || (target && !canMove(target))) return;
    movingQueue = true;
    try {
      await queueStorage(target ? "move" : "promote", job.id, target?.id, after);
    } catch (error) {
      if (!disposed) message(error.message);
    } finally {
      movingQueue = false;
      editor.refreshQueue();
    }
  }
  editor.refreshQueue = () => {
    if (disposed) return;
    queueChanged = true;
    if (refreshingQueue) return;
    refreshingQueue = true;
    void (async () => {
      while (queueChanged && !disposed) {
        queueChanged = false;
        restoredQueue = undefined;
        await restoreQueue();
      }
    })().catch(() => {}).finally(() => {
      refreshingQueue = false;
      sendNext();
    });
  };
  function restoreQueue() {
    restoredQueue ??= queueStorage("list").then(jobs => {
      if (disposed) return;
      const ids = new Set(jobs.map(job => job.id));
      for (const job of [...queued]) {
        if (job.id && !ids.has(job.id) && !job.sending && !job.editing) removeWork(job);
      }
      for (const { id, draft, goal, files, failed = false, inFlight } of jobs) {
        if (active?.id === id) continue;
        const job = queued.find(job => job.id === id);
        if (!job) {
          enqueue(id, draft, goal, files.map(file => file.link ? { ...file, size: file.link.size } : new File([file.bytes], file.name, { type: file.type })), failed, inFlight);
          continue;
        }
        const changedFlight = job.inFlight !== inFlight;
        job.inFlight = inFlight;
        if (!job.editing && !job.sending) {
          if (draft !== job.draft) {
            job.draft = draft;
            job.request = draft.trim();
            updateQueuedPreview(job);
          }
          if (failed !== job.failed || changedFlight) {
            job.failed = failed;
            renderQueuedActions(job);
          }
        }
      }
      const positions = new Map(jobs.map(({ id }, index) => [id, index]));
      const position = job => job.id ? positions.get(job.id) ?? jobs.length : -1;
      queued.sort((left, right) => position(left) - position(right));
      const focused = document.activeElement;
      let row = queue.firstElementChild;
      for (const job of queued) {
        if (!job.row) continue;
        if (row === job.row) row = row.nextElementSibling;
        else queue.insertBefore(job.row, row);
      }
      if (focused?.isConnected && queue.contains(focused) && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }
    }).catch(error => {
      restoredQueue = undefined;
      if (!disposed) message(error.message);
      throw error;
    });
    return restoredQueue;
  }
  function renderQueuedActions(job) {
    const { status } = job;
    status.replaceChildren();
    if (job.handle) {
      job.handle.draggable = !job.inFlight;
      job.handle.setAttribute("aria-disabled", String(Boolean(job.inFlight)));
    }
    if (job.inFlight) {
      status.append(element("span", () => t("ui.sending_15dba7c5")));
      return;
    }
    if (job.failed) status.append(element("span", () => t("ui.not_sent_28bb3764"), "board-queued-failed"));
    if (job.failed) status.append(button(() => t("ui.retry_553b2066"), async () => {
      await loadHistory()?.catch(() => {});
      if (!queued.includes(job)) return;
      try { await queueStorage("retry", job.id); }
      catch (error) { message(error.message); return; }
      job.failed = false;
      renderQueuedActions(job);
      sendNext();
    }, "quiet"));
    status.append(button(() => t("ui.edit_086d59cf"), () => editQueuedMessage(job), "quiet"));
    if (!job.goal) status.append(button(() => t("ui.send_now_84358b1c"), () => sendQueuedNow(job), "quiet"));
    const remove = button("", async () => {
      if (!queued.includes(job) || job.sending || job.editing) return;
      job.sending = true;
      try {
        await queueStorage("remove", job.id);
      } catch (error) {
        if (!disposed) message(error.message);
        return;
      } finally {
        job.sending = false;
      }
      if (disposed || !queued.includes(job)) return;
      queued.splice(queued.indexOf(job), 1);
      job.row.remove();
      releaseMessagePreviews(job.messageFiles);
      releaseSubmittedPreviews(job.submitted);
      message("");
      sendNext();
    }, "quiet danger board-queued-remove");
    controlLabelForIcon(remove, () => t("ui.remove_ddae809b"));
    remove.append(icon("trash"));
    status.append(remove);
  }
  function editQueuedMessage(job) {
    if (!queued.includes(job) || job.editing || job.sending) return;
    job.editing = true;
    job.preview.hidden = true;
    const edit = element("textarea", undefined, "board-queued-edit");
    edit.value = job.draft;
    bindLocalized(edit, "aria-label", () => t("ui.edit_queued_message_b141f9b1"), true);
    job.status.before(edit);
    let saving = false;
    const finish = async save => {
      if (!job.editing || saving) return;
      if (save) {
        saving = true;
        edit.readOnly = saveButton.disabled = cancel.disabled = true;
        try {
          await queueStorage("edit", job.id, edit.value);
        } catch (error) {
          message(error.message);
          return;
        } finally {
          saving = edit.readOnly = cancel.disabled = false;
          validate();
        }
        job.draft = edit.value;
        job.request = edit.value.trim();
        updateQueuedPreview(job);
      }
      job.preview.hidden = false;
      job.editing = false;
      edit.remove();
      renderQueuedActions(job);
      sendNext();
      job.status.querySelector("button")?.focus({ preventScroll: true });
    };
    const saveButton = button(() => t("ui.save_7eea8139"), () => finish(true), "quiet");
    const cancel = button(() => t("ui.cancel_4c6dcc32"), () => finish(false), "quiet");
    const validate = () => { saveButton.disabled = !edit.value.trim() && (job.goal || !job.submitted.length); };
    edit.addEventListener("input", validate);
    edit.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") finish(false);
        else if (!saveButton.disabled) finish(true);
      }
    });
    job.status.replaceChildren(saveButton, cancel);
    validate();
    edit.focus({ preventScroll: true });
  }
  async function sendQueuedNow(job) {
    if (disposed || sendingQueuedMessage || job.sending || job.editing || !queued.includes(job)) return;
    const turn = active;
    if (!turn) {
      await loadHistory()?.catch(() => {});
      if (disposed || !queued.includes(job) || job.sending || job.editing) return;
      if (active) return sendQueuedNow(job);
      await moveQueueJob(job);
      return;
    }
    sendingQueuedMessage = true;
    job.sending = true;
    const delivery = { after: turn?.lastItem };
    turn?.deliveries.set(job.id, delivery);
    job.status.replaceChildren(element("span", () => t("ui.sending_15dba7c5")));
    message("");
    try {
      const pasted = await pasteFiles(job.submitted);
      if (disposed) return;
      const result = await api.boardRequest(job.request, pasted, project, false, true, job.id);
      if (disposed) return;
      if (!result.ok) throw new Error(boardError(result.error));
      const index = queued.indexOf(job);
      if (index >= 0) queued.splice(index, 1);
      job.row.remove();
      if (!turn || turn.items.some(item => item.userMessage && item.id === job.id) || active !== turn) {
        releaseMessagePreviews(job.messageFiles);
      } else {
        delivery.fallback = { id: job.id, type: "userMessage", status: "completed", text: job.request, title: "",
          userMessage: { text: job.request, files: job.messageFiles } };
        dialogueViewport.update(() => renderTurn(turn, turn.items, false));
      }
      releaseSubmittedPreviews(job.submitted);
    } catch (error) {
      if (turn && !turn.items.some(item => item.userMessage && item.id === job.id)) turn.deliveries.delete(job.id);
      if (!disposed) {
        renderQueuedActions(job);
        message(error.message);
      }
    } finally {
      job.sending = false;
      sendingQueuedMessage = false;
      sendNext();
    }
  }
  function beginTurn(id, entry, shared = false) {
    const container = element("div", undefined, "chat-run");
    const thinking = element("div", undefined, "chat-thinking");
    const label = element("span");
    label.append(element("span", thinkingLabel(), "chat-thinking-text"));
    thinking.append(label);
    const turn = { id, entry, container, thinking, shared, deliveries: new Map(), items: [] };
    active = turn;
    syncGoal();
    busy(true);
    message("");
    thinking.setAttribute("role", "status");
    thinking.setAttribute("data-enter", "");
    dialogueViewport.update(() => {
      if (entry) log.append(entry);
      greeting.hidden = true;
      log.append(container, thinking);
    });
    return turn;
  }
  editor.updateManagerRun = run => {
    if (run === undefined || disposed) return;
    managerRun = run;
    if (active && !active.shared) return;
    if (active && active.id !== run?.id) {
      dialogueViewport.update(() => {
        active.thinking.remove();
        // The following history refresh replaces these rows with the saved transcript.
        if (!active.container.childElementCount) active.container.remove();
      });
      active = undefined;
      busy(false);
      syncGoal();
      greeting.hidden = log.childElementCount > 2;
      editor.invalidateHistory();
      if (!run) sendNext();
    }
    if (!run) return;
    if (!active) {
      const turn = beginTurn(run.id, undefined, true);
      if (editor.matches("[data-open], [data-pinned]")) refreshDialogue(turn);
    }
    waitingForChat = run.phase === "waiting";
    canStop = run.phase !== "starting";
    if (waitingForChat) showActivityStatus(waitingLabel());
    else showRunningItem(run.item);
    syncAction();
  };
  editor.updateManagerBusy = busy => {
    if (managerBusy === Boolean(busy)) return;
    managerBusy = Boolean(busy);
    if (!managerBusy) sendNext();
  };
  editor.updateManagerWork = run => {
    if (disposed) return;
    if (run !== undefined) managerWork = run;
    workToggle.classList.toggle("working", Boolean(managerWork));
    syncPrompt();
    syncGoal();
    if (!managerWork) sendNext();
  };
  function sendWorkNext() {
    const next = queued.find(job => job.goal);
    if (disposed || refreshingQueue || movingQueue || queueRetry || managerBusy || active || startingWork ||
        !next || next.failed || next.editing || next.sending || next.inFlight) return;
    startingWork = true;
    syncViews();
    next.sending = true;
    bindLocalized(next.status, "textContent", () => t("ui.starting_39fd3c7e"));
    syncGoal();
    void (async () => {
      const submitted = await pasteFiles(next.submitted);
      if (disposed) return;
      const result = await api.boardRequest(next.request, submitted, project, next.goal, false, next.id);
      if (!result.ok && result.error.code === "BOARD_QUEUE_CHANGED") {
        editor.refreshQueue();
        return;
      }
      if (!result.ok && result.error.code === "BOARD_REQUEST_IN_PROGRESS") {
        renderQueuedActions(next);
        retryQueue();
        return;
      }
      if (!result.ok) throw new Error(boardError(result.error));
      if (result.data.error && result.data.keepQueued) throw new Error(result.data.error);
      removeWork(next);
      if (result.data.error) goalError.textContent = result.data.error;
    })().catch(error => {
      goalError.textContent = error.message;
      next.failed = true;
      renderQueuedActions(next);
      message(error.message);
    }).finally(() => {
      next.sending = false;
      startingWork = false;
      syncViews();
      syncGoal();
      if (!disposed) sendWorkNext();
    });
  }
  function removeWork(job) {
    const index = queued.indexOf(job);
    if (index < 0) return;
    queued.splice(index, 1);
    job.row?.remove();
    releaseMessagePreviews(job.messageFiles ?? []);
    releaseSubmittedPreviews(job.submitted);
  }
  editor.acceptWork = id => {
    const job = queued.find(job => job.goal && job.id === id);
    if (job) removeWork(job);
  };
  function retryQueue() {
    if (disposed || queueRetry) return;
    queueRetry = setTimeout(() => {
      queueRetry = undefined;
      sendNext();
    }, 1000);
  }
  function sendNext() {
    if (refreshingQueue || movingQueue) return;
    sendWorkNext();
    const next = queued.find(job => !job.goal && !job.failed);
    if (disposed || queueRetry || managerBusy || active || sendingQueuedMessage || !next || next.editing || next.sending || next.inFlight) return;
    queued.splice(queued.indexOf(next), 1);
    const { request, goal, submitted } = next;
    next.row?.remove();
    const entry = next.entry ?? chatMessage("user", request, next.messageFiles, true, false, next.id);
    const turn = beginTurn(next.id, entry);
    const { container, thinking } = turn;
    let accepted = false;
    let deferred = false;
    let orderChanged = false;
    void (async () => {
      void loadHistory()?.catch(() => {});
      const pasted = await pasteFiles(submitted);
      if (disposed) return;
      const result = await api.boardRequest(request, pasted, project, goal, false, next.id);
      if (!result.ok && result.error.code === "BOARD_QUEUE_CHANGED") {
        orderChanged = deferred = true;
        return;
      }
      if (!result.ok && result.error.code === "BOARD_REQUEST_IN_PROGRESS") {
        deferred = true;
        retryQueue();
        return;
      }
      if (!result.ok && result.error.code === "BOARD_WAIT_CANCELLED") return;
      if (!result.ok) throw new Error(boardError(result.error));
      const { answer, error, items = [], keepQueued } = result.data;
      accepted = !keepQueued;
      dialogueViewport.update(() => {
        renderTurn(turn, items, true);
        updateUnreadMessages();
        if (answer && !container.querySelector(".chat-run-final")) chatMessage("agent", answer, [], true, true, undefined, items.findLast(item => item.type === "agentMessage")?.at);
        if (error) chatMessage("agent", error, [], true);
      });
      readVisibleMessages();
      if (!editor.isConnected || frame.project !== project || sheet.open) return;
      archiveView = false;
      render();
    })().catch(error => {
      message(error.message);
    }).finally(() => {
      dialogueViewport.update(() => {
        thinking.remove();
        if (!container.childElementCount) container.remove();
      });
      active = undefined;
      busy(false);
      syncGoal();
      if (disposed) return;
      editor.updateManagerRun(managerRun);
      if (accepted) {
        releaseSubmittedPreviews(submitted);
        if (loadingHistory || !container.childElementCount || (historyInvalidated && atEndOfHistory()) ||
            log.childElementCount - olderNodes.length - 2 > 120) {
          editor.invalidateHistory();
        }
        sendNext();
        return;
      }
      next.failed = !deferred;
      queued.unshift(next);
      renderQueuedActions(next);
      entry.remove();
      queue.prepend(next.row);
      if (orderChanged) editor.refreshQueue();
      else sendNext();
    });
  }
  editor.addEventListener("submit", async event => {
    event.preventDefault();
    if (dictation || savingQueuedMessage || !hasDraft()) return;
    const text = input.value;
    const draft = quoteMessage(text, quotes);
    const goal = goalMode;
    const submitted = [...files];
    let id;
    savingQueuedMessage = true;
    quoteDraft.sync();
    try {
      await restoreQueue();
      id = await queueStorage("add", undefined, draft, goal, await pasteFiles(submitted));
    } catch (error) {
      if (!disposed) message(error.message);
      return;
    } finally {
      savingQueuedMessage = false;
      quoteDraft.sync();
    }
    if (disposed) return;
    if (input.value === text) input.value = "";
    quotes.length = 0;
    quoteDraft.render();
    for (const file of submitted) {
      const index = files.indexOf(file);
      if (index === -1) continue;
      files.splice(index, 1);
      attachments.children[index]?.remove();
    }
    closeMentions();
    dismissedMention = undefined;
    attachments.hidden = !files.length;
    if (goalMode === goal) setGoalMode(false);
    if (active?.id !== id && !queued.some(job => job.id === id)) {
      enqueue(id, draft, goal, submitted);
    }
    openChat();
    showWork(goal);
    sendNext();
    syncAction();
  });
  function updateQueuedPreview(job) {
    job.preview.textContent = job.request.replace(/\s+/g, " ") || job.messageFiles.map(file => file.name).join(", ");
    job.preview.title = job.preview.textContent.slice(0, 180);
    if (job.handle) controlLabelForIcon(job.handle, () => t("ui.reorder_queued_message", { message: job.preview.title }));
  }
  function enqueue(id, draft, goal, submitted, failed = false, inFlight = false) {
    const request = draft.trim();
    const messageFiles = submitted.map(file => {
      if (!previewSource(file)) return { name: file.name, size: file.size, link: file.link };
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      return { name: file.name, url };
    });
    const row = element("div", undefined, "board-queued-row");
    row.setAttribute("role", "listitem");
    const handle = goal ? undefined : element("button", undefined, "button quiet board-queue-handle");
    row.append(handle ?? icon("target"));
    const images = messageFiles.filter(file => file.url);
    if (images.length) {
      const thumbnail = button("", () => previewImages(images, images[0]), "quiet board-queued-thumbnail");
      controlLabelForIcon(thumbnail, () => t("ui.view_attachments_8f71404f") + " · " + images.length);
      const image = element("img");
      image.src = images[0].url;
      image.alt = "";
      thumbnail.append(image);
      row.append(thumbnail);
    } else if (messageFiles.length) {
      row.append(icon("file"));
    }
    if (messageFiles.length) row.title = messageFiles.map(file => file.name).join("\n");
    const preview = element("span", undefined, "board-queued-preview");
    const status = element("div", undefined, "board-queued-status");
    row.append(preview, status);
    queue.append(row);
    const job = { id, row, preview, status, handle, draft, request, goal, submitted, messageFiles, failed, inFlight };
    queued.push(job);
    if (handle) {
      handle.type = "button";
      handle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
      handle.append(icon("gripper"));
      handle.addEventListener("dragstart", event => {
        if (!canMove(job) || movingQueue) { event.preventDefault(); return; }
        draggedJob = job;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", job.id);
        event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
      });
      handle.addEventListener("dragend", () => {
        draggedJob = undefined;
        clearQueueDrop();
      });
      handle.addEventListener("keydown", event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const pending = queued.filter(canMove);
        const index = pending.indexOf(job);
        const after = event.key === "ArrowDown";
        const target = pending[index + (after ? 1 : -1)];
        if (index >= 0 && target) void moveQueueJob(job, target, after);
      });
    }
    updateQueuedPreview(job);
    renderQueuedActions(job);
  }
  function addFiles(pasted) {
    message("");
    for (const file of pasted) {
      files.push(file);
      const row = element("li", undefined, "board-attachment");
      const url = !file.link && previewSource(file) ? pendingPreviews.get(file) ?? URL.createObjectURL(file) : undefined;
      if (url) pendingPreviews.set(file, url);
      const remove = button("", () => {
        files.splice(files.indexOf(file), 1);
        if (!files.includes(file)) releasePreview(file);
        row.remove();
        attachments.hidden = !files.length;
        syncAction();
        message("");
        input.focus();
      }, "quiet");
      remove.append(icon("close"));
      bindLocalized(remove, "aria-label", () => t("ui.remove_07d1de5b") + file.name, true);
      row.title = file.name;
      if (url) {
        const view = button("", () => {
          const images = files.filter(file => pendingPreviews.has(file)).map(file => ({ name: file.name, url: pendingPreviews.get(file) }));
          previewImages(images, images.find(image => image.url === url));
        }, "quiet board-attachment-preview");
        controlLabelForIcon(view, () => t("ui.view_7aa05de3") + file.name);
        const thumbnail = element("img");
        thumbnail.src = url;
        thumbnail.alt = "";
        view.append(thumbnail);
        row.classList.add("board-attachment-image");
        row.append(view);
      } else row.append(icon("attachment"), element("span", file.name + (file.size !== undefined ? " / " + file.size + " B" : "")));
      remove.classList.add("board-attachment-remove");
      row.append(remove);
      attachments.append(row);
    }
    attachments.hidden = !files.length;
    syncAction();
  }
  picker.addEventListener("change", () => { addFiles([...picker.files]); picker.value = ""; });
  editor.addEventListener("dragover", event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  editor.addEventListener("drop", event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  });
  input.addEventListener("mousedown", event => {
    // Keep the current selection when the user opens the menu elsewhere in the field.
    if (event.button === 2 && document.activeElement === input && input.selectionStart !== input.selectionEnd) {
      event.preventDefault();
    }
  });
  input.addEventListener("contextmenu", event => {
    event.preventDefault();
    input.focus();
    void api.showManagerEditMenu(input.selectionStart !== input.selectionEnd);
  });
  input.addEventListener("paste", event => {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (!pasted.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(pasted);
  });
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (mention && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      if (event.key === "Escape") {
        dismissedMention = mention.key;
        closeMentions();
      } else if (event.key === "Enter" || event.key === "Tab") {
        chooseMention(mentionIndex);
      } else {
        const count = mention.tasks.length;
        highlightMention((mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!hasDraft() && !editor.matches("[data-open], [data-pinned]")) openChat();
      else editor.requestSubmit();
    }
  });
  return editor;
}

function scheduleDay(weekday) {
  return new Date(Date.UTC(1970, 0, 4 + weekday)).toLocaleDateString(localization.locale, { weekday: "long", timeZone: "UTC" });
}

function scheduleMonth(month, day) {
  return new Date(Date.UTC(2024, month - 1, day ?? 1)).toLocaleDateString(localization.locale,
    { month: "long", ...(day === undefined ? {} : { day: "numeric" }), timeZone: "UTC" });
}

function scheduleInterval(minutes, unitDisplay) {
  const hours = minutes % 60 === 0;
  return new Intl.NumberFormat(localization.locale, { style: "unit", unit: hours ? "hour" : "minute", unitDisplay })
    .format(hours ? minutes / 60 : minutes);
}

function schedulePauseIndicator() {
  const indicator = element("span", undefined, "task-schedule-pause task-stat");
  indicator.title = t("ui.schedule_paused");
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", indicator.title);
  indicator.append(icon("debug-pause"));
  return indicator;
}

function scheduleLabel({ time, weekday, everyMinutes, dayOfMonth, month }) {
  if (everyMinutes === 60) return t("ui.every_hour_15c9e542");
  if (everyMinutes !== undefined) return t("ui.interval_e33d1556") + " · " + scheduleInterval(everyMinutes, "long");
  if (month !== undefined) return t("ui.yearly_8b5f6767") + " · " + scheduleMonth(month, dayOfMonth) + " · " + time;
  if (dayOfMonth !== undefined) return t("ui.monthly_276a90cb") + " · " +
    t("ui.day_f258ac8f") + dayOfMonth + " · " + time;
  return (weekday === undefined ? t("ui.daily_18136c90") : scheduleDay(weekday)) + " · " + time;
}

function taskEditor(task) {
  const canSetSchedule = ["draft", "ready", "blocked"].includes(task.status);
  const saved = task.schedule;
  const every = saved?.everyMinutes;
  const today = new Date();
  const mode = !saved ? "none" : every === 60 ? "hourly" : every !== undefined ? (every % 60 === 0 ? "hours" : "minutes") :
    saved.month !== undefined ? "yearly" : saved.dayOfMonth !== undefined ? "monthly" : saved.weekday === undefined ? "daily" : "weekly";
  const editor = form("editor", () => (t("ui.edit_task_9d346400")), [
    { name: "title", label: () => (t("ui.title_6365986f")), required: true, value: task.title },
    { name: "description", label: () => (t("ui.description_b4571c10")), type: "area", value: task.description },
    { name: "criteria", label: () => (t("ui.acceptance_criteria_one_per_line_5b09fa14")), type: "area",
      value: task.criteria.join("\n") },
    { name: "tags", label: () => (t("ui.tags_comma_separated_d9e75f27")), value: task.tags.join(", ") },
    { name: "priority", label: () => (t("ui.priority_b114c9b5")), value: task.priority,
      options: ["low", "normal", "high", "urgent"].map(value => [value, priorityName(value)]) },
    { name: "dueDate", label: () => (t("ui.due_date_d764b025")), type: "date", value: task.dueDate ?? "" },
    ...(canSetSchedule ? [
      { name: "scheduleMode", label: () => (t("ui.schedule_dadf83ce")), value: mode, options: [
        ["none", t("ui.no_schedule_b2eefabd")], ["hourly", t("ui.every_hour_15c9e542")],
        ["minutes", t("ui.every_n_minutes_9203a97e")], ["hours", t("ui.every_n_hours_4561039a")],
        ["daily", t("ui.daily_at_a_set_time_14f74f4e")], ["weekly", t("ui.weekly_at_a_set_time_f22bc85c")],
        ["monthly", t("ui.monthly_276a90cb")], ["yearly", t("ui.yearly_8b5f6767")],
      ] },
      { name: "scheduleInterval", label: () => (t("ui.interval_e33d1556")), type: "number", value: mode === "hours" ? every / 60 : mode === "minutes" ? every : 1 },
      { name: "scheduleTime", label: () => (t("ui.local_time_0e59cd18")), type: "time", value: saved?.time ?? "" },
      { name: "scheduleDay", label: () => (t("ui.day_of_week_29b15d5a")), value: String(saved?.weekday ?? today.getDay()),
        options: [1, 2, 3, 4, 5, 6, 0].map(day => [String(day), scheduleDay(day)]) },
      { name: "scheduleMonth", label: () => (t("ui.month_ac4f9d49")), value: String(saved?.month ?? today.getMonth() + 1),
        options: Array.from({ length: 12 }, (_, index) => [String(index + 1), scheduleMonth(index + 1)]) },
      { name: "scheduleDate", label: () => (t("ui.day_of_month_93059e4b")), type: "number", value: saved?.dayOfMonth ?? today.getDate() },
    ] : []),
    { name: "note", label: () => (t("ui.reason_for_change_148dfb0c")) },
  ], () => (t("ui.save_7eea8139")), async values => {
    const data = {
      title: values.title, description: values.description, criteria: lineList(values.criteria),
      tags: values.tags.split(",").map(tag => tag.trim()).filter(Boolean), priority: values.priority,
      dueDate: values.dueDate || null,
      actor: "user", revision: task.revision, ...(values.note ? { note: values.note } : {}),
    };
    if (canSetSchedule) {
      const { scheduleMode, scheduleTime, scheduleDay, scheduleMonth, scheduleDate, scheduleInterval: interval } = values;
      const schedule = {
        none: null, hourly: { everyMinutes: 60 }, minutes: { everyMinutes: Number(interval) }, hours: { everyMinutes: 60 * Number(interval) },
        daily: { time: scheduleTime }, weekly: { time: scheduleTime, weekday: Number(scheduleDay) },
        monthly: { time: scheduleTime, dayOfMonth: Number(scheduleDate) },
        yearly: { time: scheduleTime, dayOfMonth: Number(scheduleDate), month: Number(scheduleMonth) },
      }[scheduleMode];
      if (schedule?.time !== saved?.time || schedule?.weekday !== saved?.weekday || schedule?.everyMinutes !== saved?.everyMinutes ||
          schedule?.dayOfMonth !== saved?.dayOfMonth || schedule?.month !== saved?.month) {
        data.schedule = schedule;
      }
    }
    const updated = await command("update", task.id, data);
    if (updated) await showTask(updated.id);
  });
  if (!canSetSchedule) return;
  const { scheduleMode, scheduleInterval: interval, scheduleTime: time, scheduleDay: day, scheduleMonth: month, scheduleDate: date } = editor.elements;
  interval.min = "1";
  date.min = "1";
  const showFields = () => {
    const mode = scheduleMode.value;
    interval.parentElement.hidden = interval.disabled = mode !== "minutes" && mode !== "hours";
    time.parentElement.hidden = time.disabled = !["daily", "weekly", "monthly", "yearly"].includes(mode);
    day.parentElement.hidden = day.disabled = mode !== "weekly";
    month.parentElement.hidden = month.disabled = mode !== "yearly";
    date.parentElement.hidden = date.disabled = mode !== "monthly" && mode !== "yearly";
    date.max = mode === "yearly" ? String(new Date(2024, Number(month.value), 0).getDate()) : "31";
    interval.required = !interval.disabled;
    time.required = !time.disabled;
    date.required = !date.disabled;
  };
  scheduleMode.addEventListener("change", showFields);
  month.addEventListener("change", showFields);
  showFields();
}

function openTaskSheet(task) {
  openSheet("task", task.id + (task.title ? " · " + task.title : ""));
  const runStatus = element("span", undefined, "task-agent-run muted");
  runStatus.id = "task-agent-run";
  renderAgentRunStatus(runStatus, task);
  byId("sheet-title").append(runStatus);
  const lane = lanes.find(([state]) => state === task.status);
  const status = manualBoard() ? manualColumns().find(c => c.id === task.status)?.name ?? task.status : lane ? t(lane[1]) : task.status;
  const metadata = [status, task.priority && priorityName(task.priority), task.updatedAt && shortDate(task.updatedAt)].filter(Boolean);
  if (metadata.length) body.append(element("p", metadata.join(" · "), "muted"));
}

function stateLabel(done, text, taskId = taskInSheet?.id) {
  const label = element("div", undefined, "task-state-label");
  const state = icon(done ? "check" : "circle");
  state.removeAttribute("aria-hidden");
  state.setAttribute("role", "img");
  bindLocalized(state, "aria-label", () => done ? t("ui.completed_a863c619") : t("ui.pending_f3563d6f"), true);
  label.append(state, chatText(text, { taskId }));
  return label;
}

function taskBriefSections(task) {
  taskDescription(task.description, task.id);
  const subtasks = task.subtasks?.map(item => stateLabel(item.done, item.title, task.id));
  section(() => t("ui.subtasks_b409bda5"), subtasks);
  const criteria = task.criteria?.map(criterion => chatText(criterion, { taskId: task.id }));
  section(() => t("ui.acceptance_criteria_7e3779c2"), criteria);
}

async function showTask(id, dialogue = false) {
  const request = ++taskSheetRequest;
  const project = frame.project;
  const refresh = sheet.open && sheetKind === "task" && taskInSheet?.id === id;
  let loading;
  if (!refresh) {
    const preview = frame.board?.tasks.find(task => task.id === id) ??
      frame.board?.archived?.find(task => task.id === id) ?? { id };
    taskInSheet = undefined;
    openTaskSheet(preview);
    taskBriefSections(preview);
    loading = element("p", () => t("ui.loading_task_details_35f0b01e"), "muted");
    loading.setAttribute("role", "status");
    body.append(loading);
    body.scrollTop = 0;
  }
  const result = await api.command("show", id).catch(error => ({ ok: false, error }));
  if (request !== taskSheetRequest || project !== frame.project || !sheet.open) return;
  if (!result.ok) {
    notice(boardError(result.error));
    if (loading) {
      loading.replaceWith(button(() => t("ui.retry_loading_d44dbc69"), () => showTask(id)));
    }
    return;
  }
  const task = result.data;
  const scroll = refresh ? body.scrollTop : 0;
  const focusedChat = refresh && document.activeElement.id === "task-chat-input" ? document.activeElement : undefined;
  const openDetails = new Set(refresh ? [...body.querySelectorAll(".task-details[open]")].map(details => details.id) : []);
  taskInSheet = task;
  openTaskSheet(task);
  if (task.status === "blocked" && task.blocked) body.append(blockerBanner(task.blocked));
  if (showUnconfirmedLaunch(task)) {
    const explanation = element("p", () => t("ui.unconfirmed_executor_launch"), "muted");
    explanation.id = "task-unconfirmed-launch";
    body.append(explanation);
  }
  savedChangesSection(task, task.savedChanges);
  if (task.tags.length) {
    const tags = element("div", undefined, "task-tags");
    tags.id = "task-sheet-tags";
    tags.append(...tagBadges(task.tags));
    body.append(tags);
  }
  if (task.milestone) {
    const { repository, number, title } = task.milestone;
    body.append(button(() => t("ui.github_milestone_11d33bfa") + " · " + title,
      () => api.openLink("https://github.com/" + repository + "/milestone/" + number), "quiet task-milestone-link"));
  }
  taskBriefSections(task);
  const stagePanels = !manualBoard() && !task.expertStage ? expertTeamSection(task) : undefined;
  const renderStageWork = stageWork(task, stagePanels);
  if (!manualBoard()) {
    if (task.expertStage) body.append(button(task.expertStage.parentId, () => showTask(task.expertStage.parentId), "quiet"));
  }
  if (task.status === "in_progress") section(() => (t("ui.submission_1577a02d")), t("ui.result_not_submitted_61369662"));
  section(() => (t("ui.progress_d4dff843")), task.summary);
  section(() => (t("ui.next_step_09895a4d")), task.nextStep);
  if (task.dependencies?.length) {
    const waiting = new Set(task.unfinishedDependencies);
    const names = new Map([...(frame.board?.tasks ?? []), ...(frame.board?.archived ?? [])]
      .map(entry => [entry.id, entry.title]));
    const label = waiting.size ? t("ui.blocked_by_dependencies_07f97df3") :
      t("ui.task_dependencies_496b3742");
    section(label, task.dependencies.map(id => stateLabel(!waiting.has(id),
      id + (names.has(id) ? " · " + names.get(id) : ""))));
  }
  if (task.execution) {
    section(() => (t("ui.execution_settings_aceb50d5")), task.execution.model + " · " +
      (task.execution.effort ?? t("ui.provider_default_69f2d8eb")));
  }
  if (task.schedule) {
    const schedule = [scheduleLabel(task.schedule)];
    if (task.schedule.paused) schedule.push(schedulePauseIndicator());
    if (!task.schedule.paused && task.status === "ready" && !task.unfinishedDependencies?.length) {
      schedule.push(t("ui.next_run_c1b8ce6d") + " · " + shortDate(task.schedule.nextAt));
    }
    section(() => (t("ui.schedule_dadf83ce")), schedule);
  }
  showSubmissionResult(task.result);
  const renderReviewStage = stagePanels && [...stagePanels.keys()].some(key => key.startsWith("review:"))
    ? items => renderStageWork("review", items)
    : undefined;
  if (!manualBoard()) showTaskReviewHistory(task, openDetails.has("task-review-history"), renderReviewStage);
  showTaskArtifacts(task, body, openDetails.has("task-review-files"));
  if (task.git) showTaskGit(task.git, openDetails.has("task-git"));
  if (task.attachments.length) {
    const images = task.attachments.filter(isImageAttachment);
    const previous = selectedCover(task, images)?.file ?? "";
    if (manualBoard() && (images.length > 1 || (images.length === 1 && !previous)) && !frame.board?.archived.some(entry => entry.id === task.id)) {
      const label = element("label", undefined, "task-cover-setting");
      label.append(element("span", () => t("ui.card_cover_43d5cce6")));
      const picker = element("select");
      if (!previous) {
        const none = localizedOption(t("ui.no_cover_9544aee1"), "");
        none.disabled = true;
        picker.append(none);
      }
      picker.append(...images.map(file => localizedOption(file.name, file.file)));
      picker.value = previous;
      picker.addEventListener("change", protect(async () => {
        picker.disabled = true;
        try {
          const updated = await command("attachment-cover", task.id, { file: picker.value, revision: task.revision });
          if (updated && taskInSheet?.id === task.id && sheetKind === "task") await showTask(task.id);
          if (!updated) picker.value = previous;
        } finally {
          picker.disabled = false;
        }
      }));
      label.append(picker);
      body.append(label);
    }
    const chatFiles = new Set(task.history.flatMap(event => event.chat?.files ?? []));
    const cardAttachments = task.attachments.filter(file => !chatFiles.has(file.file));
    const cardImages = cardAttachments.filter(isImageAttachment);
    const downloads = element("div", undefined, "sheet-actions");
    for (const attachment of cardAttachments) {
      const index = cardImages.indexOf(attachment);
      if (index >= 0) {
        const view = button("", () => openImagePreview(task.id, cardImages, index), "quiet");
        view.append(icon("search"));
        controlLabelForIcon(view, () => t("ui.view_7aa05de3") + attachment.name);
        downloads.append(view);
      }
      downloads.append(taskAttachmentButton(task.id, attachment));
    }
    if (downloads.childElementCount) body.append(downloads);
  }
  const actions = element("div", undefined, "sheet-actions");
  const act = async (name, input) => {
    const result = await command(name, task.id, { revision: task.revision, ...input });
    if (result) await showTask(task.id);
  };
  if (task.schedule && !["done", "cancelled"].includes(task.status)) {
    actions.append(button(() => t(task.schedule.paused ? "ui.resume_schedule" : "ui.pause_schedule"),
      () => act("update", { schedulePaused: !task.schedule.paused })));
  }
  if (task.status === "draft") {
    if (task.awaitingAnswer === true) {
      body.append(element("p", () => t("task_question.approval_blocked"), "muted"));
      actions.append(button(() => t("task_question.open_dialogue_button"), () => showTask(task.id, true)));
    } else if (!task.approvalRequirements?.length) {
      actions.append(button(() => t("ui.approve_535c27a7"), () => act("approve"), "primary"));
    }
  }
  if (["ready", "in_progress", "blocked", "review", "cancelled"].includes(task.status) ||
      (task.status === "done" && !manualBoard())) {
    actions.append(button(() => t("ui.return_to_draft_ccd17679"), () => act("return-to-draft")));
  }
  if (task.workingDirectory) {
    const directory = element("section", undefined, "sheet-section");
    const location = element("p", () => t("ui.working_directory_b37ab351") + " · ");
    location.append(element("code", task.workingDirectory));
    directory.append(location);
    body.append(directory);
  }
  if (task.status === "review") {
    const reviewLabel = task.result?.noChanges
      ? t("ui.review_result_74026356")
      : t("ui.review_changes_da4882b7");
    actions.append(button(reviewLabel, () => showReview(task), "primary"));
    actions.append(button(() => t("ui.request_changes_d5a65360"), () => noteTask(task, "request-changes")));
  }
  if (task.git?.worktree) actions.append(button(() => t("ui.open_worktree_c2f75966"), async () => {
    const result = await api.openWorktree(task.id);
    if (!result.ok) notice(boardError(result.error));
  }));
  if (!["done", "cancelled"].includes(task.status)) {
    if (manualBoard()) actions.append(button(() => t("ui.edit_c25be9fb"), () => taskEditor(task)));
    else actions.append(button(() => t("ui.cancel_task_e9e056a5"), () => noteTask(task, "cancel"), "danger"));
  }
  if (manualBoard()) {
    const history = task.history.filter(event => event.action === "manual-move");
    if (history.length) {
      const details = element("details", undefined, "task-details");
      details.append(element("summary", "История перемещений"));
      for (const event of history) details.append(element("p", `${shortDate(event.at)} · ${event.text}`));
      body.append(details);
    }
    const label = element("label", "Переместить дело");
    const select = element("select");
    for (const column of manualColumns()) {
      const option = element("option", column.name + (column.terminal ? " (завершение)" : ""));
      option.value = column.id; select.append(option);
    }
    select.value = task.status;
    select.addEventListener("change", protect(() => act("manual-move", { to: select.value })));
    label.append(select); actions.prepend(label);
  }
  const codexAction = codexTaskAction(task);
  if (codexAction) actions.append(codexAction);
  body.append(actions);
  const side = byId("task-side");
  side.replaceChildren(taskChat(task, renderStageWork));
  side.hidden = false;
  if (dialogue) {
    side.firstChild.openDialogue();
    side.querySelector(".task-dialogue").focus({ preventScroll: true });
  }
  body.scrollTop = scroll;
  if (focusedChat && byId("task-chat-input")) {
    byId("task-chat-input").focus({ preventScroll: true });
    byId("task-chat-input").setSelectionRange(focusedChat.selectionStart, focusedChat.selectionEnd);
  }
}

function taskDetails(id, title, hint, open) {
  const details = element("details", undefined, "task-details");
  details.id = id;
  details.open = open;
  const header = element("summary", undefined, "task-details-header");
  const arrow = element("i", undefined, "codicon codicon-chevron-right");
  arrow.setAttribute("aria-hidden", "true");
  header.append(arrow, element("span", title));
  if (hint) header.append(element("span", hint, "task-details-hint"));
  details.append(header);
  return details;
}

function showTaskReviewHistory(task, open, onActivity) {
  if (task.status !== "review" && !task.history.some(event => event.action === "submit" || event.actor === "reviewer")) return;
  const area = taskDetails("task-review-history", () => t("ui.reviewer_messages_d84eb921"), undefined, open);
  const journal = element("ol", undefined, "task-details-content task-review-history");
  const decisions = [];
  let submittedAt = "";
  for (const event of task.history) {
    if (event.action === "submit") submittedAt = event.at;
    if (event.actor !== "reviewer" || !event.text ||
        !["review-approve", "review-note", "request-changes"].includes(event.action)) continue;
    const entry = element("li", undefined, "chat-entry chat-coordination");
    entry.dataset.actor = "reviewer";
    entry.dataset.historyAt = event.at;
    entry.append(element("span", () => t("ui.reviewer_50c42665"), "chat-author"), reviewerFindings(event.text, task.id));
    appendChatTime(entry, event.at);
    journal.append(entry);
    decisions.push({ entry, event, submittedAt });
  }
  area.append(journal);
  area.refreshReview = reviewerHistory(task, journal, decisions, onActivity);
  area.addEventListener("toggle", () => {
    if (area.open) area.refreshReview();
  });
  body.append(area);
  if (area.open || onActivity) area.refreshReview();
}

function showTaskArtifacts(task, target = body, open = false) {
  if (!task.artifacts?.length) return;
  const count = () => activityCount(task.artifacts.length, "file");
  const area = taskDetails("task-review-files", () => t("ui.review_materials_92f4029c"), count, open);
  const content = element("div", undefined, "task-details-content");
  const groups = [
    [/\.(?:json|xml|html?|md|txt)$/i, t("ui.reports_and_documents_5658d1c1")],
    [/\.(?:log|out)$/i, t("ui.logs_c537772c")],
    [/\.(?:ps1|sh|bat|cmd|py|mjs|js)$/i, t("ui.scripts_7464d20e")],
    [/\.(?:sha256|sha512|sha1|md5)$/i, t("ui.checksums_7770b10e")],
    [/.*/, t("ui.other_files_27b7b593")],
  ];
  const entries = task.artifacts.map(artifact => ({ ...artifact, name: artifact.source.split(/[\\/]/).at(-1) }));
  const byName = Map.groupBy(entries, entry => entry.name);
  const byGroup = Map.groupBy(entries, entry => groups.find(([pattern]) => pattern.test(entry.name)));
  const reveal = t("ui.show_in_folder_b28477b9");
  for (const group of groups) {
    const files = byGroup.get(group);
    if (!files) continue;
    const list = element("ul", undefined, "task-review-files");
    for (const { name, source, sha256 } of files) {
      const link = button("", async () => {
        const result = await api.revealArtifact(task.id, source, sha256);
        if (!result.ok) notice(boardError(result.error));
      }, "quiet task-review-file");
      link.title = source + "\nSHA-256 " + sha256;
      const label = element("span", name, "task-review-file-name");
      const evidence = task.result?.artifactEvidence?.find(entry => entry.source === source && entry.sha256 === sha256);
      if (evidence) label.append(element("small", evidence.output));
      const matching = byName.get(name);
      if (matching.length > 1) {
        const directory = source.slice(0, -name.length);
        const repeatedPath = matching.filter(entry => entry.source === source).length > 1;
        const version = repeatedPath ? sha256.slice(0, 12) : "";
        label.append(element("small", [directory, version].filter(Boolean).join(" · ")));
      }
      link.append(label, element("span", reveal, "task-review-file-action"));
      const row = element("li");
      row.append(link);
      list.append(row);
    }
    content.append(element("h3", group[1]), list);
  }
  area.append(content);
  target.append(area);
}

function showTaskGit(git, open) {
  const area = taskDetails("task-git", t("ui.git_details_fba72c7b"),
    git.target?.replace(/^refs\/heads\//, ""), open);
  const info = element("dl", undefined, "task-details-content task-git-info");
  const fields = [
    [t("ui.target_branch_ee9809a9"), git.target],
    [t("ui.task_worktree_59613a98"), git.worktree],
    [t("ui.submitted_commit_7227319d"), git.submission?.sha],
    [t("ui.acceptance_commit_6a6295e9"), git.accepted],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const item = element("dd");
    item.append(element("code", value));
    info.append(element("dt", label), item);
  }
  if (!info.childElementCount) return;
  area.append(info);
  body.append(area);
}

function taskAttachmentButton(id, attachment, kind) {
  const download = button(attachment.name + " / " + attachment.bytes + " B", async () => {
    const result = await api.saveAttachment(id, attachment.file, attachment.name);
    if (!result.ok) notice(boardError(result.error));
  }, kind);
  download.prepend(icon(attachment.link ? "link-external" : "cloud-download"));
  return download;
}

function noteTask(task, action) {
  const comment = action === "comment";
  form("note", () => (comment ? t("ui.add_comment_9058117e") : t("ui.reason_927778b8")), [
    { name: "note", label: () => (comment ? t("ui.comment_15031549") : t("ui.reason_927778b8")), type: "area", required: true },
  ], () => (t("ui.save_7eea8139")), async ({ note }) => {
    const saved = await command(action, task.id, {
      revision: task.revision, actor: "user", [comment ? "text" : "reason"]: note,
    });
    if (saved) await showTask(task.id);
  });
}

function savedChangesSection(task, saved, pending = false) {
  if (!saved) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", () => t("ui.saved_local_changes_3b78b116")));
  if (saved.restored) {
    area.append(element("p", () => t("ui.restored_to_a90084ee") + saved.restored.path));
  } else {
    const restore = async destination => {
      const result = await command("restore-changes", task.id, { revision: task.revision, destination });
      if (result) await showTask(task.id);
    };
    const actions = element("div", undefined, "sheet-actions");
    if (!pending) {
      const target = task.git.target.replace(/^refs\/heads\//, "");
      actions.append(button(() => t("ui.restore_in_15dbe6f3") + target, () => restore("target")));
    }
    actions.append(button(() => t("ui.restore_in_a_separate_worktree_194c39a7"), () => restore("worktree")));
    area.append(actions);
  }
  body.append(area);
}

async function showAcceptedTask(task) {
  await showTask(task.id);
  const messages = [];
  if (task.localChangesWarning) messages.push(boardError(task.localChangesWarning));

  if (messages.length) notice(messages.join("\n"));
}

function acceptanceRepairStatus(id, repair) {
  if (frame.quotaTasks?.includes(id)) return quotaLabel();
  if (repair.reason) return repair.reason;
  const label = {
    queued: "ui.waiting_for_a_reviewer_slot_8918dd95",
    running: "ui.resolving_acceptance_conflict",
    checking: "ui.accepting_task_39473c27",
  }[repair.phase];
  return label ? t(label) : "";
}

async function showReview(task, messageDraft, acceptanceError) {
  if (task.acceptanceRepair) {
    taskInSheet = task;
    const editor = form("review", () => t("ui.review_result_29ed25fb"), [], () => t("ui.cancel_4c6dcc32"), async () => {
      const cancelled = await command("accept", task.id, { revision: task.revision, cancelRepair: true });
      if (cancelled) sheet.close();
    });
    const status = element("p", acceptanceRepairStatus(task.id, task.acceptanceRepair), "muted");
    status.id = "acceptance-repair-status";
    editor.before(status);
    body.append(button(() => t("ui.work_activity_e01957b7"), () => showTask(task.id)));
    return;
  }
  const generation = projectGeneration;
  const review = await command("review", task.id);
  if (!review || generation !== projectGeneration) return;
  task = { ...task, revision: review.revision, result: review.result };
  taskInSheet = task;
  const hybrid = review.reviewMode === "reviewer-human";
  const canAccept = !review.pendingModeChanged && (!hybrid || review.pending || review.awaitingHumanAcceptance);
  const decision = { revision: review.revision, targetHead: review.targetHead, reviewModeVersion: review.reviewModeVersion };
  const showReviewStatus = editor => {
    if (!canAccept) editor.querySelector("button[type=submit]").disabled = true;
    if (!hybrid || review.pendingModeChanged) return;
    editor.before(element("p", () => t(canAccept ? "ui.awaiting_human_acceptance" : "ui.awaiting_reviewer_approval"), "muted"));
  };
  if (review.noChanges) {
    const editor = form("review", () => (t("ui.review_result_29ed25fb")), [], () => (t("ui.accept_e596557e")), async () => {
      const accepted = await command("accept", task.id, decision);
      if (accepted && generation === projectGeneration) await showAcceptedTask(accepted);
    });
    section(() => (t("ui.acceptance_criteria_7e3779c2")), task.criteria);
    showSubmissionResult(review.result);
    showTaskArtifacts(task);
    body.prepend(element("p", () => t("ui.submitted_without_git_changes_f0133a15"), "muted"));
    body.append(editor);
    showReviewStatus(editor);
    if (review.stale) {
      notice(t("ui.the_task_worktree_changed_submit_it_again_6605626c"));
      editor.querySelector("button[type=submit]").disabled = true;
    }
    return;
  }
  const local = review.localChanges;
  const editor = form("review", () => (t("ui.review_changes_07438d12")), [
    { name: "message", label: () => (t("ui.acceptance_commit_message_dea3218b")), type: "area",
      value: messageDraft ?? review.message, required: true },
  ], () => (t("ui.accept_e596557e")), async ({ message }) => {
    const result = await api.command("accept", task.id, {
      ...decision, message,
    });
    if (generation !== projectGeneration) return;
    if (!result.ok && result.error.code === "ACCEPTANCE_CANCELLED") return;
    if (result.ok) {
      if (result.data.status === "review") {
        await showTask(task.id);
      } else await showAcceptedTask(result.data);
    } else {
      if (sheetKind === "review" && taskInSheet?.id === task.id) await showReview(task, message, result.error);
      else notice(boardError(result.error), [t("ui.accepting_task_39473c27"), task.id, projectName()].join(" · "));
    }
  });
  showReviewStatus(editor);
  if (review.pendingModeChanged) {
    editor.before(element("p", () => t("ui.recover_interrupted_acceptance_hint"), "muted"));
    editor.before(button(() => t("ui.recover_interrupted_acceptance"), async () => {
      const recovered = await command("accept", task.id, { revision: review.revision, cancelPending: true });
      if (recovered?.status === "done") await showAcceptedTask(recovered);
      else if (recovered) {
        await showTask(task.id);
        if (recovered.localChangesWarning) notice(boardError(recovered.localChangesWarning));
      }
    }));
  }
  const diff = renderReviewDiff(review.diff);
  const caption = element("p", review.target + " · " + review.mode + " · " + review.submitted.slice(0, 12), "muted");
  body.prepend(caption, diff);
  const submittedResult = document.createDocumentFragment();
  showSubmissionResult(review.result, submittedResult);
  showTaskArtifacts(task, submittedResult);
  editor.before(submittedResult);
  if (local && !review.pending) {
    const overlap = new Set(local.overlaps);
    const changes = element("section", undefined, "sheet-section");
    changes.append(element("h3", () => t("ui.local_changes_in_the_target_worktree_6c472a81")));
    changes.append(element("p", local.path, "muted"));
    const list = element("ul");
    for (const path of local.paths) {
      list.append(element("li", () => path + (overlap.has(path) ? t("ui.also_changed_by_the_task_f67b08b8") : "")));
    }
    changes.append(list);
    changes.append(element("p", () => local.token
      ? t("ui.your_local_changes_will_remain_in_the_worktree_a_3fea9d42")
      : t("ui.the_current_git_state_prevents_automatic_preserv_a9fb58c6")));
    editor.before(changes);
    if (!local.token) editor.querySelector("button[type=submit]").disabled = true;
  }
  savedChangesSection(task, review.savedChanges, review.pending);
  const conflict = review.merge?.status === "conflict" ? { code: "MERGE_CONFLICT", details: { paths: review.merge.paths } } :
    acceptanceError?.code === "MERGE_CONFLICT" && acceptanceError.details?.targetHead === review.targetHead ? acceptanceError : undefined;
  if (conflict) {
    const input = JSON.stringify({ revision: task.revision, resolveConflicts: true });
    const prompt = [
      t("ui.resolve_conflicts_in_task_ff6b0c1e") + task.id + ".",
      t("ui.use_ai_taskboard_c846ccf1") + "start " + task.id + " --stdin " +
        t("ui.with_json_input_e1a266ab") + input + ".",
      t("ui.resolve_the_conflicts_in_the_task_worktree_run_t_20e7434e"),
    ].join("\n");
    body.append(button(() => t("ui.copy_request_for_agent_867df7ad"), async () => {
      await navigator.clipboard.writeText(prompt);
      notice(t("ui.request_copied_6c774d2f"));
    }));
  }
  if (review.stale && !review.pending) {
    notice(t("ui.the_task_worktree_changed_submit_it_again_6605626c"));
    body.querySelector("button[type=submit]").disabled = true;
  } else if (conflict || acceptanceError) notice(boardError(conflict ?? acceptanceError));
  if (canAccept) body.append(button(() => t("ui.use_an_existing_acceptance_commit_90cb1c90"), () => {
    form("review", () => (t("ui.existing_acceptance_commit_d9e22415")), [
      { name: "commit", label: () => (t("ui.full_commit_sha_79b43d04")), required: true },
    ], () => (t("ui.verify_and_accept_541b58d4")), async ({ commit }) => {
      const accepted = await command("accept", task.id, { ...decision, commit });
      if (accepted) await showAcceptedTask(accepted);
    });
    body.prepend(element("p", review.target, "muted"));
  }));
}

function codexSettings() {
  const section = element("section", undefined, "provider-panel");
  section.append(element("h3", () => t("ui.codex_model_provider_f3e6e4a2")));
  const status = element("p", () => t("ui.checking_codex_cd8163c2"), "muted");
  status.setAttribute("role", "status");
  const details = element("p", undefined, "muted");
  const actions = element("div", undefined, "sheet-actions");
  const choose = button(() => t("ui.choose_executable_f8497481"), () => update(api.chooseCodex));
  const auto = button(() => t("ui.detect_automatically_5e0e5b8a"), () => update(api.autoDetectCodex));
  const refresh = button(() => t("ui.refresh_status_33d6f5e4"), () => update(api.codexStatus));
  const sandboxLabel = element("label", () => t("ui.windows_sandbox_cf9271b6"));
  const sandbox = element("select");
  sandbox.append(localizedOption("MXC", "mxc"), localizedOption("Elevated", "elevated"));
  sandboxLabel.append(sandbox);
  sandboxLabel.hidden = true;
  sandbox.addEventListener("change", () => update(() => api.setCodexWindowsSandbox(sandbox.value)));
  actions.append(choose, auto, refresh);
  const accountStatus = element("p", undefined, "muted");
  accountStatus.setAttribute("role", "status");
  const modeLabel = element("label", () => t("codexAuth.mode"));
  const mode = element("select");
  mode.append(localizedOption(() => t("codexAuth.profile"), "profile"),
    localizedOption(() => t("codexAuth.api"), "api"));
  modeLabel.append(mode);
  const keyLabel = element("label", () => t("codexAuth.key"));
  const key = element("input");
  key.type = "password";
  key.autocomplete = "off";
  key.spellcheck = false;
  key.maxLength = 512;
  keyLabel.append(key);
  const authFeedback = element("p", undefined, "muted");
  authFeedback.setAttribute("role", "status");
  const apply = button(() => t("codexAuth.apply"), async () => {
    const credential = mode.value === "api" ? key.value : "";
    key.value = "";
    refreshApplyLabel();
    await update(async () => {
      const result = await api.setCodexAuth(mode.value, credential);
      bindLocalized(authFeedback, "textContent", () => t("codexAuth." + result.outcome));
      return result.status ?? api.codexStatus();
    }, false);
  });
  const billing = element("p", () => t("codexAuth.billing"), "muted");
  function refreshApplyLabel() {
    const label = mode.value === "api" && key.value !== "" ? "codexAuth.checkAndApply" : "codexAuth.apply";
    bindLocalized(apply, "textContent", () => t(label));
  }
  function showKey() {
    keyLabel.hidden = mode.value !== "api";
    if (keyLabel.hidden) key.value = "";
    refreshApplyLabel();
  }
  key.addEventListener("input", refreshApplyLabel);
  mode.addEventListener("change", () => {
    authFeedback.textContent = "";
    showKey();
  });
  showKey();
  section.append(status, details, actions, sandboxLabel, accountStatus, modeLabel, keyLabel, billing, apply, authFeedback);
  body.append(section);

  let savedSandbox;
  async function update(load, syncMode = true) {
    for (const item of actions.children) item.disabled = true;
    sandbox.disabled = true;
    for (const control of [mode, key, apply]) control.disabled = true;
    bindLocalized(status, "textContent", () => t("ui.checking_codex_cd8163c2"));
    try {
      const result = await load();
      const messages = {
        unavailable: t("ui.codex_with_app_server_support_was_not_found_26b78d67"),
        ready: t("ui.codex_executable_found_e0939b8c"),
        error: t("ui.could_not_check_codex_a3675ed8"),
      };
      status.textContent = messages[result.state] || messages.error;
      details.textContent = [result.clientPath ?? result.selectedPath, result.clientVersion ? "Codex " + result.clientVersion : "",
        result.error].filter(Boolean).join(" · ");
      auto.hidden = !result.selectedPath;
      savedSandbox = result.windowsSandbox;
      sandboxLabel.hidden = !savedSandbox;
      if (syncMode || result.authMode === mode.value) {
        mode.value = result.authMode ?? "profile";
        showKey();
      }
      bindLocalized(accountStatus, "textContent", () => t("codexAuth.account." + (result.account ?? "unknown")));
    } catch (error) {
      bindLocalized(status, "textContent", () => t("ui.could_not_check_codex_a3675ed8"));
      details.textContent = error.message;
    } finally {
      for (const item of actions.children) item.disabled = false;
      if (savedSandbox) sandbox.value = savedSandbox;
      sandbox.disabled = false;
      for (const control of [mode, key, apply]) control.disabled = false;
    }
  }

  void update(api.codexStatus);
}

function tagColorInput(value, label) {
  const control = element("span", undefined, "tag-color-input");
  const picker = element("input");
  picker.type = "color";
  picker.setAttribute("aria-label", label);
  const hex = element("input");
  hex.required = true;
  hex.pattern = "#[0-9a-fA-F]{6}";
  hex.spellcheck = false;
  hex.setAttribute("aria-label", label + " (HEX)");
  hex.title = "#RRGGBB";
  const set = color => {
    hex.value = color;
    picker.value = color;
  };
  set(value);
  hex.addEventListener("input", () => {
    if (hex.checkValidity()) picker.value = hex.value;
  });
  picker.addEventListener("change", () => {
    set(picker.value.toUpperCase());
    hex.dispatchEvent(new Event("change"));
  });
  control.append(hex, picker);
  return { control, hex, picker, set };
}

function renderTagSettings(panel) {
  const focusedTag = panel.contains(document.activeElement) ? document.activeElement.dataset.tag : undefined;
  const add = element("form", undefined, "tag-create");
  const name = element("input");
  name.required = true;
  bindLocalized(name, "placeholder", () => t("ui.tag_name_931e4e21"));
  name.setAttribute("aria-label", name.placeholder);
  const color = tagColorInput("#6747A9", t("ui.new_tag_color_c25b655d"));
  const submit = element("button", () => t("ui.add_tag_19f3b654"), "button");
  submit.type = "submit";
  add.append(name, color.control, submit);
  add.addEventListener("submit", event => {
    event.preventDefault();
    void protect(async () => {
      submit.disabled = true;
      try {
        if (await command("tag-create", undefined, { name: name.value, color: color.hex.value })) name.value = "";
      } finally { submit.disabled = false; }
    })();
  });
  panel.replaceChildren(element("h3", () => t("ui.board_tags_3fd0e833")), add);
  const tags = [...boardTags.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const tag of tags) {
    const row = element("div", undefined, "tag-setting");
    const badge = tagBadge(tag.name, tag.color);
    const { control, hex, picker, set } = tagColorInput(tag.color, tag.name);
    hex.dataset.tag = tag.name;
    hex.addEventListener("keydown", event => {
      if (event.key === "Enter" && hex.reportValidity()) hex.blur();
    });
    hex.addEventListener("change", protect(async () => {
      if (!hex.reportValidity()) return;
      hex.disabled = picker.disabled = true;
      try {
        const saved = await command("tag-color", undefined, { name: tag.name, color: hex.value });
        set(saved?.color ?? tag.color);
        if (saved?.color) badge.style.setProperty("--tag-color", saved.color);
      } finally { hex.disabled = picker.disabled = false; }
    }));
    row.append(badge, control);
    panel.append(row);
    if (tag.name === focusedTag) hex.focus();
  }
}

async function expertSettings() {
  const entries = await command("experts");
  if (!entries) return;
  openSheet("experts", () => t("experts.title"));
  const search = element("input", undefined, "expert-search");
  search.type = "search"; search.placeholder = t("experts.search"); search.setAttribute("aria-label", t("experts.search"));
  const list = element("div", undefined, "expert-list");
  const render = () => {
    const query = search.value.toLocaleLowerCase();
    list.replaceChildren(...entries.filter(expert => (expert.name + " " + expert.group + " " + expert.id).toLocaleLowerCase().includes(query))
      .map(expert => button(expert.name + " · " + expert.group + (expert.enabled ? "" : " · " + t("experts.disabled")), async () => {
        const full = await command("expert-get", undefined, { expertId: expert.id });
        if (full) editExpert(full, entries);
      }, "quiet")));
  };
  search.addEventListener("input", render);
  body.append(button(() => t("experts.new"), () => editExpert(undefined, entries)), search, list);
  render(); search.focus();
}

function editExpert(expert, entries) {
  const skills = structuredClone(expert?.skills ?? []);
  const expertId = expert?.id ?? "custom-" + crypto.randomUUID();
  const editor = form("expert-editor", expert?.name ?? (() => t("experts.new")), [
    { name: "name", label: () => t("experts.name"), value: expert?.name, required: true },
    { name: "group", label: () => t("experts.group"), value: expert?.group, required: true },
    { name: "enabled", label: () => t("experts.enabled"), type: "checkbox", value: expert?.enabled ?? true },
    { name: "prompt", label: () => t("experts.prompt"), type: "area", value: expert?.prompt, required: true },
  ], () => t("ui.save_settings_2173b7d7"), async values => {
    if (await command("expert-save", undefined, { ...values, id: expertId, skills,
      ...(expert ? { revision: expert.revision } : {}), requirements: expert?.requirements ?? [], limitations: expert?.limitations ?? "" })) {
      await expertSettings();
    }
  });
  const panel = element("section", undefined, "expert-skills");
  const render = () => {
    panel.replaceChildren(element("h3", () => t("experts.skills")));
    for (const skill of skills) {
      const row = element("div", undefined, "expert-skill");
      const label = element("label", () => t("experts.name"));
      const name = element("input"); name.value = skill.name; name.required = true;
      name.addEventListener("input", () => { skill.name = name.value; }); label.append(name); row.append(label);
      if (skill.library) row.append(button(() => t("experts.view"), async () => {
        const source = expert?.skills.some(s => s.id === skill.id) ? expert : entries.find(e => e.skills.some(s => s.id === skill.id));
        const value = source && await command("expert-skill", undefined, { expertId: source.id, skillId: skill.id });
        if (value && row.isConnected) {
          const preview = element("pre", value.content, "expert-skill-preview"); row.append(preview);
        }
      }, "quiet"));
      else {
        const label = element("label", () => t("experts.skill_content"));
        const content = element("textarea"); content.value = skill.content; content.required = true;
        content.addEventListener("input", () => { skill.content = content.value; }); label.append(content); row.append(label);
      }
      row.append(button(() => t("experts.remove"), () => { skills.splice(skills.indexOf(skill), 1); render(); }, "quiet"));
      panel.append(row);
    }
    panel.append(button(() => t("experts.add_skill"), () => {
      skills.push({ id: "skill-" + crypto.randomUUID(), name: t("experts.add_skill"), content: "" }); render();
    }, "quiet"));
  };
  render();
  const library = [...new Map(entries.flatMap(expert => expert.skills).filter(skill => skill.library).map(skill => [skill.library, skill])).values()];
  const choose = element("select"); choose.setAttribute("aria-label", t("experts.add_library"));
  for (const skill of library) { const option = element("option", skill.name); option.value = skill.id; choose.append(option); }
  const add = button(() => t("experts.add_library"), () => {
    const skill = library.find(skill => skill.id === choose.value);
    if (skill && !skills.some(s => s.id === skill.id)) { skills.push({ ...skill, library: skill.id }); render(); }
  }, "quiet");
  editor.querySelector('button[type="submit"]').before(panel, choose, add);
}

const taskExpertCatalog = new Map();
function expertRoleNames(project) {
  let catalog = taskExpertCatalog.get(project);
  if (!catalog) {
    const version = frame.board?.expertCatalogVersion;
    const names = api.command("experts").then(result => {
      if (!result.ok) throw new Error(boardError(result.error));
      if (taskExpertCatalog.get(project) !== catalog) return;
      return new Map(result.data.map(expert => [expert.id, expert.name]));
    }).catch(() => {
      if (taskExpertCatalog.get(project) === catalog) {
        taskExpertCatalog.delete(project);
      }
    });
    catalog = { names, version };
    taskExpertCatalog.set(project, catalog);
  }
  return catalog.names;
}

function expertAvatar(id, name) {
  const short = { "qa-engineer": "QA", "ux-designer": "UX", "ui-designer": "UI",
    "frontend-developer": "FE", "backend-developer": "BE" };
  const initials = short[id] ?? name.match(/[\p{L}\p{N}]+/gu)?.slice(0, 2).map(word => word[0]).join("").toUpperCase() ?? "?";
  const avatar = element("span", initials, "expert-avatar");
  avatar.style.setProperty("--expert-hue", [...id].reduce((hue, char) => (hue * 31 + char.codePointAt(0)) % 360, 0));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function expertTeamSection(task) {
  const area = element("section", undefined, "expert-team");
  const project = frame.project;
  const panels = new Map();
  area.append(element("h3", () => t("experts.plan_title")));
  if (task.approvalRequirements?.length) {
    const reason = element("p", () => t("experts.approval_incomplete") + " " +
      task.approvalRequirements.map(field => t("experts.missing_" + field)).join(", ") + ".", "muted");
    reason.classList.add("expert-approval-requirements");
    area.append(reason);
  }
  const labels = new Map();
  const keyForTask = frame.project + "\0" + task.id;
  const openStages = chatDrafts.get(keyForTask)?.openStages;
  const role = id => {
    const label = element("span", id?.replaceAll("-", " "));
    if (id) {
      if (!labels.has(id)) labels.set(id, []);
      labels.get(id).push(label);
    }
    return label;
  };
  const phases = element("div", undefined, "expert-team-phases");
  for (const phase of ["work", "review"]) {
    const plan = task.expertTeam?.[phase];
    const lead = phase === "work" && plan?.lead === undefined ? task.expertId : plan?.lead;
    const phaseArea = element("section", undefined, "expert-phase");
    const header = element("header", undefined, "expert-phase-header");
    header.append(element("h4", () => t(phase === "work" ? "experts.work_phase" : "experts.review_phase")));
    const assignment = element("div", undefined, "expert-lead");
    if (lead) assignment.append(expertAvatar(lead, lead), role(lead), element("span", () => t("experts.lead"), "muted"));
    else assignment.append(element("span", () => t("experts.no_lead"), "muted"));
    header.append(assignment);
    phaseArea.append(header);
    if (plan?.reason) {
      const reason = chatText(plan.reason, { taskId: task.id });
      reason.classList.add("expert-phase-reason");
      phaseArea.append(reason);
    }
    for (const stage of plan?.stages ?? []) {
      const state = task.expertStageStatus?.[phase]?.find(item => item.key === stage.key);
      const details = element("details", undefined, "expert-stage");
      const key = phase + ":" + stage.key;
      details.open = openStages?.has(key) ?? false;
      details.addEventListener("toggle", () => {
        const draft = chatDrafts.get(keyForTask);
        if (!draft || !details.isConnected) return;
        const expanded = draft.openStages ??= new Set();
        if (details.open) expanded.add(key);
        else expanded.delete(key);
      });
      const title = element("summary", undefined, "expert-stage-row");
      const copy = element("span", undefined, "expert-stage-copy");
      copy.append(element("strong", stage.title), role(stage.expertId));
      title.append(icon("chevron-right"), expertAvatar(stage.expertId, stage.expertId), copy);
      if (state) {
        const status = element("span", () => t("experts.stage_" + state.state), "expert-stage-status");
        status.dataset.state = state.state;
        title.append(status);
      }
      details.append(title);
      const work = element("div", undefined, "expert-stage-work");
      const log = element("div", undefined, "chat-log expert-stage-log");
      log.tabIndex = 0;
      log.setAttribute("role", "region");
      bindLocalized(log, "aria-label", () => t("ui.work_activity_e01957b7"), true);
      work.append(element("h5", () => t("ui.work_activity_e01957b7")), log);
      details.append(work);
      panels.set(key, log);
      phaseArea.append(details);
    }
    const legacy = phase === "work" ? task.expertStages ?? [] : [];
    for (const stage of legacy) {
      const child = frame.board?.tasks.find(entry => entry.id === stage.taskId) ?? frame.board?.archived?.find(entry => entry.id === stage.taskId);
      const link = button("", () => showTask(stage.taskId), "quiet");
      link.append(stage.title + " · ", role(child?.expertId ?? stage.expertId));
      if (child) link.append(element("span", () => " · " + t("status." + child.status)));
      phaseArea.append(link);
    }
    if (!plan?.stages.length && !legacy.length) phaseArea.append(element("p", () => t("experts.no_stages"), "muted"));
    phases.append(phaseArea);
  }
  area.append(phases);
  let teamMail;
  if (task.history.some(event => event.expertMessage)) {
    const mail = element("details");
    teamMail = expertTeamMail(task);
    mail.append(element("summary", () => t("experts.conversation")), teamMail);
    area.append(mail);
  }
  body.append(area);
  if (labels.size || teamMail?.setRoleNames) {
    area.refreshRoleNames = async () => {
      const names = await expertRoleNames(project);
      if (!names || !area.isConnected || frame.project !== project) return;
      for (const [id, nodes] of labels) {
        for (const label of nodes) {
          label.textContent = names.get(id) ?? id.replaceAll("-", " ");
        }
      }
      teamMail?.setRoleNames?.(names);
    };
    void area.refreshRoleNames();
  }
  return panels;
}

function expertTeamMail(task) {
  const log = element("section", undefined, "task-team-mail");
  if (task.expertStage) {
    log.append(button(task.expertStage.parentId, () => showTask(task.expertStage.parentId), "quiet"));
    return log;
  }
  const list = element("ol", undefined, "expert-conversation");
  const entries = [];
  const address = id => {
    const [phase, key] = id.split(":");
    const stage = task.expertTeam?.[phase]?.stages.find(item => item.key === key);
    if (stage) return { role: stage.expertId, name: stage.title };
    if (id === task.id) return { role: task.expertTeam?.work?.lead ?? task.expertId, name: t("ui.executor_92197b27") };
    if (id === "reviewer") return { role: task.expertTeam?.review?.lead, name: t("ui.reviewer_50c42665") };
    const child = task.expertStages?.find(stage => stage.taskId === id);
    if (child) return { role: child.expertId, name: child.title };
    const labels = { owner: "experts.owner", manager: "experts.manager", team: "experts.all" };
    return { name: Object.hasOwn(labels, id) ? t(labels[id]) : id };
  };
  task.history.forEach((event, index) => {
    if (!event.expertMessage) return;
    const { from, to, replyTo } = event.expertMessage;
    const sender = address(from);
    const recipient = address(to);
    const row = element("li", undefined, "expert-message");
    row.id = "team-message-" + (index + 1);
    const bubble = element("article", undefined, "expert-bubble");
    const header = element("div", undefined, "expert-bubble-header");
    const author = element("strong", sender.name, "expert-author");
    const route = element("small", undefined, "expert-recipient");
    const recipientLabel = element("span", recipient.name);
    route.append(icon("arrow-right"), recipientLabel);
    header.append(author);
    appendChatTime(header, event.at);
    bubble.append(header, route);
    if (replyTo && task.history[replyTo - 1]?.expertMessage) {
      const jump = button(() => t("experts.referenced_message") + " #" + replyTo, () => {
        const previous = list.querySelector("#team-message-" + replyTo);
        previous?.scrollIntoView({ block: "nearest" });
        previous?.focus({ preventScroll: true });
      }, "quiet expert-message-reference");
      bubble.append(jump);
    }
    bubble.append(chatText(event.text ?? "", { taskId: task.id }));
    const avatar = expertAvatar(sender.role ?? from, sender.name);
    row.tabIndex = -1;
    row.append(avatar, bubble);
    list.append(row);
    entries.push({ sender, recipient, author, recipientLabel, avatar });
  });
  if (!entries.length) log.append(element("p", () => t("experts.no_mail"), "muted"));
  else {
    log.append(list);
    log.setRoleNames = names => {
      for (const entry of entries) {
        const { sender, recipient, author, recipientLabel } = entry;
        const name = names.get(sender.role) ?? sender.name;
        if (author.textContent !== name) {
          author.title = sender.name === name ? "" : sender.name;
          author.textContent = name;
          const avatar = expertAvatar(sender.role, name);
          entry.avatar.replaceWith(avatar);
          entry.avatar = avatar;
        }
        const target = names.get(recipient.role);
        recipientLabel.textContent = target && target !== recipient.name ? target + " · " + recipient.name : recipient.name;
      }
    };
  }
  return log;
}

async function backupSettings() {
  openSheet("backups", () => t("backup.title"));
  const content = element("section", undefined, "form backup-form");
  const project = frame.board?.project;
  const path = element("p", "", "muted");
  const lastSuccess = element("p");
  const error = element("p");
  error.setAttribute("role", "status");
  const automatic = element("input");
  automatic.type = "checkbox";
  const automaticLabel = element("label", undefined, "form-checkbox");
  automaticLabel.append(automatic, element("span", () => t("backup.automatic")));
  const create = button(() => t("backup.create"), () => run(() => api.backupCreate()));
  const list = element("select");
  const label = element("label");
  label.append(element("span", () => t("backup.select")), list);
  const restore = button(() => t("backup.restore"), () => run(async () => {
    if (await api.backupRestore(list.value)) {
      if (content.isConnected) sheet.close();
    }
  }), "primary");
  const date = value => new Date(value).toLocaleString(localization.locale);
  let busy = false;

  function controls(disabled) {
    automatic.disabled = create.disabled = disabled || !project;
    restore.disabled = list.disabled = disabled || !list.value;
  }

  async function refresh() {
    const status = await api.backupStatus();
    if (!content.isConnected) return;
    path.textContent = t("backup.storage", { path: status.root });
    automatic.checked = status.nextAutomatic !== undefined;
    lastSuccess.textContent = status.lastSuccess
      ? t("backup.success", { date: date(status.lastSuccess) })
      : t("backup.noSuccess");
    error.textContent = status.error || "";
    const previous = list.value;
    list.replaceChildren(...status.backups.map(backup => {
      const option = element("option", date(backup.createdAt) + " · " + backup.project);
      option.value = backup.id;
      return option;
    }));
    if (!list.options.length) {
      const empty = element("option", t("backup.empty"));
      empty.value = "";
      list.append(empty);
    }
    if (status.backups.some(backup => backup.id === previous)) list.value = previous;
    controls(busy);
  }

  async function run(action) {
    busy = true;
    controls(true);
    let failure;
    try {
      await action();
    } catch (error) {
      failure = error.message;
    } finally {
      busy = false;
      if (content.isConnected) {
        await refresh();
        if (failure) error.textContent = failure;
      }
    }
  }

  automatic.addEventListener("change", protect(() => run(() => api.backupAutomatic(automatic.checked))));
  content.append(path);
  if (project) content.append(automaticLabel, create, lastSuccess);
  content.append(label, restore, error, element("p", () => t("backup.retention"), "muted"));
  body.append(content);
  controls(true);
  await refresh();
  const timer = setInterval(() => {
    if (!content.isConnected || !sheet.open) clearInterval(timer);
    else if (!busy) void refresh().catch(error => notice(error.message));
  }, 15_000);
}

function settings() {
  // The expert catalogue belongs to the selected board, including its overrides.
  const roles = [
    ["executor", () => t("limits.work")],
    ["reviewer", () => t("limits.review")],
  ];
  const editor = form("settings", () => (t("ui.application_settings_b131bcd2")),
    roles.map(([name, label]) => ({ name, label, type: "number", required: true })),
    () => (t("ui.save_limits_5ec81bed")), async values => {
      const result = await api.taskLimits(Object.fromEntries(Object.entries(values).map(([role, value]) => [role, Number(value)])));
      if (!result.ok) return notice(boardError(result.error));
      if (editor.isConnected) sheet.close();
    });
  editor.id = "agent-limits";
  editor.prepend(element("h3", () => t("limits.title")),
    element("p", () => t("ui.defaults_for_each_board_board_settings_can_overr_e97efc09"), "muted"));
  const inputs = [...editor.querySelectorAll('input[type="number"]')];
  const save = editor.querySelector('button[type="submit"]');
  for (const input of inputs) input.disabled = true;
  save.disabled = true;
  void api.taskLimits().then(result => {
    if (!editor.isConnected) return;
    if (!result.ok) return notice(boardError(result.error));
    for (const [index, [role]] of roles.entries()) {
      inputs[index].value = result.data[role];
      inputs[index].disabled = false;
    }
    save.disabled = false;
  }).catch(error => { if (editor.isConnected) notice(error.message); });
  appearanceSettings();
  body.append(button(() => t("backup.title"), backupSettings));
  codexSettings();
  if (frame.board) body.append(button(() => t("experts.title"), () => expertSettings()));
}

function boardSettings() {
  if (!frame.board) return;
  if (manualBoard()) return manualBoardSettings();
  chatCatalog = undefined;
  const current = frame.board.settings;
  const { project, managerAccess = "auto" } = frame;
  const reviewMode = current.reviewMode ?? (current.autoReview === true ? "reviewer" : "human");
  const defaultModel = () => t("ui.codex_default_646ad954");
  const roles = [
    ["manager", t("ui.project_manager_48697fa0")],
    ["executor", t("ui.executor_92197b27")],
    ["reviewer", t("ui.reviewer_50c42665")],
  ];
  const agentFields = roles.map(([role]) => {
    const model = current[role]?.model ?? "";
    const effort = current[role]?.effort ?? "";
    return [
      { name: role + "Provider", label: () => (t("ui.provider_b1139466")), value: current[role]?.provider ?? "codex",
        options: [["codex", "Codex"]] },
      { name: role + "Model", label: () => (t("ui.model_a909c227")), value: model,
        options: model ? [[model, model]] : [["", defaultModel]] },
      { name: role + "Effort", label: () => (t("ui.reasoning_effort_f0ee1b26")), value: effort,
        options: [[effort, effort ? reasoningName(effort) : defaultModel]] },
    ];
  });
  let models = [];
  const editor = form("board-settings", () => (t("ui.board_settings_780b5083") + " · " + projectName()), [
    { name: "name", label: () => (t("ui.board_name_blank_uses_folder_name_1c570f41")), value: current.name },
    { name: "archive", label: () => (t("ui.archive_after_days_blank_disables_8e341281")),
      type: "number", value: current.archiveAfterDays },
    { name: "mode", label: () => (t("ui.acceptance_mode_61f390cc")), value: current.integrationMode,
      options: [["merge", "Merge"], ["squash", "Squash"]] },
    { name: "showCardPreviews", label: () => (t("ui.show_previews_on_board_cards_a3f2af17")),
      type: "checkbox", value: current.showCardPreviews !== false },
    { name: "reviewMode", label: () => (t("ui.who_reviews_tasks_3636b553")),
      value: reviewMode, options: [
        ["human", t("ui.human_56f4a79e")],
        ["manager", t("ui.project_manager_48697fa0")],
        ["reviewer", t("ui.reviewer_50c42665")],
        ["reviewer-human", t("ui.review_then_human")],
      ] },
    ...agentFields.flat(),
    { name: "executorLimit", type: "number", label: () => t("limits.work"), value: current.taskLimits?.executor },
    { name: "reviewerLimit", type: "number", label: () => t("limits.review"), value: current.taskLimits?.reviewer },
    { name: "managerAccess", label: () => (t("ui.access_mode_on_this_computer_d6a20a28")),
      value: managerAccess, options: [
        ["ask", t("ui.ask_for_approval_cc8bdc3b")],
        ["auto", t("ui.approve_for_me_64ade20f")],
        ["full", t("ui.full_access_47d69a72")],
      ] },
  ], () => (t("ui.save_settings_2173b7d7")), async values => {
    const agents = {};
    const taskLimits = {};
    for (const [role, title] of roles) {
      if (role !== "manager" && values[role + "Limit"] !== "") taskLimits[role] = Number(values[role + "Limit"]);
      const { [role + "Provider"]: provider, [role + "Model"]: model, [role + "Effort"]: effort } = values;
      if (provider === (current[role]?.provider ?? "codex") && model === (current[role]?.model ?? "") &&
          effort === (current[role]?.effort ?? "")) continue;
      if (model && !models.some(entry => entry.id === model && (entry.effort === effort || entry.efforts.includes(effort)))) {
        notice(title + " · " + t("ui.choose_an_available_model_and_reasoning_effort_a7381192"));
        return;
      }
      agents[role] = model ? { provider, model, effort } : null;
    }
    if (await command("settings", undefined, {
      ...(values.name.trim() !== (current.name ?? "") ? { name: values.name } : {}),
      archiveAfterDays: values.archive === "" ? null : Number(values.archive), integrationMode: values.mode,
      showCardPreviews: values.showCardPreviews,
      ...(values.reviewMode !== reviewMode ? { reviewMode: values.reviewMode } : {}),
      ...(roles.some(([role]) => taskLimits[role] !== current.taskLimits?.[role]) ? { taskLimits } : {}),
      ...agents,
    })) {
      if (values.managerAccess !== managerAccess) {
        const result = await api.setManagerAccess(project, values.managerAccess);
        if (!result.ok) return notice(boardError(result.error));
      }
      sheet.close();
    }
  });
  const [, review, ...selects] = editor.querySelectorAll("select");
  body.append(button(() => t("experts.title"), () => expertSettings()));
  const reviewHint = element("small", undefined, "muted");
  const updateReviewHint = () => {
    bindLocalized(reviewHint, "textContent", () => ({
      human: t("ui.you_decide_whether_to_accept_the_task_or_return__2b0d5a6d"),
      manager: t("ui.the_project_manager_checks_the_submission_and_de_c9044678"),
      reviewer: t("ui.the_reviewer_checks_submissions_the_manager_deci_9b1a5dc9"),
      "reviewer-human": t("ui.review_then_human_hint"),
    }[review.value]));
  };
  review.parentElement.append(reviewHint);
  review.addEventListener("change", updateReviewHint);
  updateReviewHint();
  const limitPhases = ["executor", "reviewer"];
  const limits = limitPhases.map(role => editor.elements.namedItem(role + "Limit"));
  const limitGroup = element("fieldset", undefined, "board-agent-settings");
  limits[0].parentElement.before(limitGroup);
  limitGroup.append(element("legend", () => t("limits.title")), ...limits.map(input => input.parentElement));
  selects[0].parentElement.before(element("p", () => t("ui.an_empty_limit_uses_the_application_default_use__f19c1da9"), "muted"));
  void api.taskLimits().then(result => {
    if (!result.ok || !editor.isConnected) return;
    limitPhases.forEach((role, index) => { limits[index].placeholder = String(result.data[role]); });
  }).catch(() => {});
  const roleControls = roles.map(([role, title], index) => {
    const [provider, model, effort] = selects.slice(index * 3, index * 3 + 3);
    const group = element("fieldset", undefined, "board-agent-settings");
    provider.parentElement.before(group);
    group.append(element("legend", title), provider.parentElement, model.parentElement, effort.parentElement);
    if (role === "manager") group.append(editor.elements.namedItem("managerAccess").parentElement);
    const savedModel = current[role]?.model ?? "";
    const savedEffort = current[role]?.effort ?? "";
    const showEfforts = (saved = "") => {
      const selected = models.find(entry => entry.id === model.value);
      const options = [...new Set([...(selected?.efforts ?? []), selected?.effort].filter(Boolean))];
      if (saved && !options.includes(saved)) options.push(saved);
      effort.replaceChildren(...(options.length ? options.map(value => localizedOption(reasoningName(value), value)) :
        [localizedOption(defaultModel, "")]));
      effort.disabled = !selected || !options.length;
      effort.value = saved || selected?.effort || options[0] || "";
    };
    model.disabled = effort.disabled = true;
    model.addEventListener("change", () => showEfforts(model.value === savedModel ? savedEffort : ""));
    return () => {
      model.replaceChildren(localizedOption(defaultModel, ""), ...models.map(entry => localizedOption(entry.name, entry.id)));
      if (savedModel && !models.some(entry => entry.id === savedModel)) {
        model.append(localizedOption(savedModel + " · " + t("ui.unavailable_31fb3a55"), savedModel));
      }
      model.value = savedModel;
      model.disabled = !models.length && !savedModel;
      showEfforts(savedEffort);
    };
  });
  const modelStatus = element("p", () => t("ui.loading_codex_models_284f7ca2"), "muted");
  modelStatus.setAttribute("role", "status");
  editor.lastElementChild.before(modelStatus);
  void Promise.resolve().then(() => api.chatModels()).catch(error => ({ ok: false, error: { message: error.message } })).then(result => {
    if (!editor.isConnected) return;
    models = result.ok ? result.data : [];
    roleControls.forEach(refresh => refresh());
    bindLocalized(modelStatus, "textContent", () => !result.ok ? boardError(result.error) : !models.length ?
      t("ui.no_codex_models_available_97612bb5") : "");
    modelStatus.hidden = !modelStatus.textContent;
  });
  body.append(button(() => t("ui.check_archives_now_511c7ff2"), () => command("archive")));
  const tags = element("section", undefined, "tag-settings");
  tags.id = "tag-settings";
  renderTagSettings(tags);
  body.append(tags);
}

const systemPalette = matchMedia("(prefers-color-scheme: dark)");
let paletteTransition;

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const select = byId("theme-select");
  if (select) {
    select.value = theme;
  }
  const palette = theme === "system" ? (systemPalette.matches ? "dark" : "light") : theme;
  if (root.dataset.palette === palette) {
    return;
  }
  const initialized = Boolean(root.dataset.palette);
  const updatePalette = () => {
    const selected = root.dataset.theme;
    root.dataset.palette = selected === "system" ? (systemPalette.matches ? "dark" : "light") : selected;
  };
  paletteTransition?.skipTransition();
  if (!initialized || reducedMotion.matches || !document.startViewTransition) {
    updatePalette();
    return;
  }
  paletteTransition = document.startViewTransition(updatePalette);
  // A rapid theme change can skip a transition before its snapshot is ready.
  paletteTransition.ready.catch(() => {});
}

systemPalette.addEventListener("change", () => applyTheme(frame.theme ?? "system"));
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    paletteTransition?.skipTransition();
  }
});

function appearanceSettings() {
  const panel = element("section", undefined, "appearance-panel");
  panel.append(element("h3", () => t("ui.appearance_0dc18b20")));
  const label = element("label", () => t("ui.theme_9b54a012"));
  const select = element("select");
  select.id = "theme-select";
  select.disabled = true;
  label.append(select);
  panel.append(label);
  const languageLabel = element("label", () => t("settings.language"));
  const languageSelect = element("select");
  languageSelect.id = "language-select";
  languageSelect.append(localizedOption(() => t("settings.system"), "system"), ...Object.entries(localization.names).map(([id, name]) => localizedOption(name, id)));
  languageSelect.value = frame.localization?.preference ?? "system";
  languageSelect.addEventListener("change", protect(async () => {
    const result = await api.setLanguage(languageSelect.value);
    if (!result.ok) { languageSelect.value = frame.localization?.preference ?? "system"; notice(boardError(result.error)); }
  }));
  languageLabel.append(languageSelect);
  panel.append(languageLabel);
  body.prepend(panel);
  api.themes().then(themes => {
    const translated = {
      system: () => t("ui.system_e345d2c2"),
      light: () => t("ui.light_10ab3a96"),
      dark: () => t("ui.dark_43d15be6"),
    };
    select.replaceChildren(...themes.map(([id, label]) => localizedOption(translated[id] ?? label, id)));
    select.value = frame.theme ?? "system";
    select.disabled = false;
  }).catch(error => notice(error.message));
  select.addEventListener("change", protect(async () => {
    select.disabled = true;
    try {
      const result = await api.setTheme(select.value);
      if (!result.ok) {
        select.value = frame.theme;
        notice(boardError(result.error));
      }
    } finally {
      select.disabled = false;
    }
  }));
}

let gitMenuRequest = 0;

async function gitCommand(action, input, project) {
  const result = await api.command("git-" + action, undefined, input);
  if (frame.project !== project) return;
  if (!result.ok) {
    const actions = {
      refs: ["ui.loading_git_branches_00628ca6"],
      create: ["ui.creating_git_branch_d3bc3a06"],
      switch: ["ui.switching_git_branch_3f9946bf"],
      detach: ["ui.checking_out_a_git_revision_346a017d"],
      publish: ["ui.publishing_to_github_608d7660"],
      push: ["ui.pushing_commits_67d32648"],
    };
    const label = actions[action] ?? ["ui.git_operation_fe57178a"];
    notice(boardError(result.error), [t(...label), projectName()].filter(Boolean).join(" · "));
    return;
  }
  notice();
  if (result.data?.gitInfo && frame.board) {
    frame.board.gitInfo = result.data.gitInfo;
    renderStatusBar(false);
  }
  return result.data;
}

function updateGitRevision(data) {
  const git = frame.board.gitInfo;
  const tracking = git?.branch === data.branch && git?.head === data.head ? git?.tracking : undefined;
  const sameBranch = git?.branch === data.branch;
  frame.board.gitInfo = { ...git, branch: data.branch, head: data.head, tracking,
    pushTarget: sameBranch ? git?.pushTarget : undefined,
    pushError: sameBranch ? git?.pushError : "destination" };
  renderStatusBar(false);
}

function newGitBranch(snapshot, ref, project) {
  const editor = form("git-branch", () => (t("ui.create_new_branch_1d92f466")), [
    { name: "name", label: () => (t("ui.branch_name_3f030859")), required: true },
  ], () => (t("ui.create_and_switch_f330fba5")), async ({ name }) => {
    const data = await gitCommand("create", { head: snapshot.head, branch: snapshot.branch, ref, name }, project);
    if (!data || !editor.isConnected || frame.project !== project) return;
    updateGitRevision(data);
    sheet.close();
  });
  const source = ref ?? (snapshot.head ? snapshot.branch ?? "HEAD" : undefined);
  editor.prepend(element("p", () => source ? t("ui.create_from_1544a833") + source :
    t("ui.name_for_the_first_commit_95390a29"), "muted"));
  editor.querySelector("input").focus();
}

function relativeCommitDate(value, now = Date.now()) {
  const seconds = (new Date(value).getTime() - now) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (Math.abs(seconds) < 60) return t("ui.just_now_b217cbb7");
  const [unit, size] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]
    .find(([, size]) => Math.abs(seconds) >= size);
  return new Intl.RelativeTimeFormat(localization.locale, { numeric: "auto", style: "short" })
    .format(Math.round(seconds / size), unit);
}

async function openGitBranches() {
  const menu = byId("git-branches");
  bindLocalized(menu, "aria-label", () => t("ui.branches_and_tags_c785cf53"), true);
  const project = frame.project;
  const request = ++gitMenuRequest;
  menu.replaceChildren(element("p", () => t("ui.loading_branches_cd662059"), "muted"));
  const data = await gitCommand("refs", undefined, project);
  if (!data || request !== gitMenuRequest || !menu.matches(":popover-open")) return;
  let mode = "switch";
  let busy = false;
  const search = element("input");
  search.type = "search";
  search.hidden = data.refs.length === 0;
  bindLocalized(search, "aria-label", () => t("ui.search_branches_and_tags_7edd67f8"), true);
  const action = (labelKey, symbol, click) => {
    const item = button("", click, "quiet git-menu-action");
    item.append(icon(symbol), element("span", () => t(labelKey)));
    return item;
  };
  const create = action("ui.create_new_branch_f31212fe", "plus", () => {
    if (!busy) newGitBranch(data, undefined, project);
  });
  const from = action("ui.create_new_branch_from_74774417", "plus", () => {
    mode = "create";
    draw();
    search.focus();
  });
  const detach = action("ui.checkout_detached_8477312a", "git-branch", () => {
    mode = "detach";
    draw();
    search.focus();
  });
  const back = action("ui.back_to_branches_44e68db0", "arrow-left", () => {
    mode = "switch";
    draw();
    search.focus();
  });
  const list = element("div", undefined, "git-ref-list");
  const choose = async ref => {
    if (busy) return;
    if (mode === "create") return newGitBranch(data, ref.ref, project);
    busy = true;
    for (const control of menu.querySelectorAll("button, input")) control.disabled = true;
    try {
      const next = await gitCommand(mode, { head: data.head, branch: data.branch, ref: ref.ref }, project);
      if (next && request === gitMenuRequest) {
        updateGitRevision(next);
        if (menu.matches(":popover-open")) menu.hidePopover();
      }
    } finally {
      busy = false;
      for (const control of menu.querySelectorAll("button, input")) control.disabled = false;
    }
  };
  function draw() {
    bindLocalized(search, "placeholder", () => mode === "create" ? t("ui.choose_a_starting_branch_or_tag_f238af64")
      : mode === "detach" ? t("ui.choose_a_branch_or_tag_for_detached_head_f98946d5")
      : t("ui.search_branches_and_tags_8496e76e"));
    create.hidden = mode !== "switch";
    from.hidden = detach.hidden = create.hidden || search.hidden;
    back.hidden = mode === "switch";
    const query = search.value.toLocaleLowerCase();
    const refs = data.refs.filter(ref => [ref.name, ref.sha, ref.author, ref.subject].some(value => value.toLocaleLowerCase().includes(query)));
    list.replaceChildren(...(refs.length ? refs.map(ref => {
      const entry = button("", () => choose(ref), "quiet git-ref");
      const current = !ref.tag && ref.name === data.branch;
      entry.setAttribute("aria-current", String(current));
      const heading = element("span", undefined, "git-ref-heading");
      const name = element("span", ref.name, "git-ref-name");
      const date = element("time", relativeCommitDate(ref.date), "git-ref-date");
      date.dateTime = ref.date;
      date.setAttribute("aria-label", new Date(ref.date).toLocaleString(localization.locale));
      heading.append(icon(ref.tag ? "git-tag" : "git-branch"), name);
      if (current) heading.append(icon("check"));
      heading.append(date);
      const detail = element("span", undefined, "git-ref-detail");
      detail.append(element("span", ref.author, "git-ref-author"), element("span", ref.sha.slice(0, 8), "git-ref-hash"),
        element("span", ref.subject, "git-ref-subject"));
      entry.append(heading, detail);
      return entry;
    }) : [element("p", () => search.hidden ? t("ui.no_branches_or_tags_yet_10aea593") :
      t("ui.no_matching_branches_or_tags_67e760d6"), "muted")]));
  }
  search.addEventListener("input", draw);
  menu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const controls = [...menu.querySelectorAll("input, button")].filter(item => !item.hidden && !item.disabled);
    const index = controls.indexOf(document.activeElement);
    event.preventDefault();
    controls.at((index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length)?.focus();
  }, { signal: gitMenuKeys.signal });
  menu.replaceChildren(search, create, from, detach, back, list);
  draw();
  (search.hidden ? create : search).focus();
}

let gitMenuKeys = new AbortController();
let publishingGit = false;
const gitPushes = new Map();

async function pushTrackedBranch() {
  const project = frame.project;
  const { branch, head, pushTarget } = frame.board?.gitInfo ?? {};
  if (!project || !branch || !head || !pushTarget || gitPushes.has(project)) return;
  gitPushes.set(project, branch);
  renderStatusBar(false);
  try {
    await gitCommand("push", { branch, head }, project);
  } finally {
    gitPushes.delete(project);
    if (frame.project === project) renderStatusBar(false);
  }
}

async function publishToGitHub() {
  if (publishingGit) return;
  const project = frame.project;
  const snapshot = await gitCommand("refs", undefined, project);
  if (!snapshot) return;
  const editor = form("git-publish", () => (t("ui.publish_to_github_5ba684aa")), [
    { name: "name", label: () => (t("ui.repository_name_or_owner_name_6ab89215")), required: true,
      value: project.split(/[\\/]/).at(-1).replace(/[^A-Za-z0-9_.-]/g, "-") },
    { name: "visibility", label: () => (t("ui.visibility_a6c69e21")), value: "private", options: [
      ["private", t("ui.private_a6676b3c")], ["public", t("ui.public_b76d6d50")],
    ] },
  ], () => (t("ui.publish_21b4ab90")), async ({ name, visibility }) => {
    publishingGit = true;
    byId("status-publish").disabled = true;
    const status = editor.querySelector("p");
    bindLocalized(status, "textContent", () => t("ui.publishing_bab966ea"));
    try {
      const result = await gitCommand("publish", { head: snapshot.head, branch: snapshot.branch, name, visibility }, project);
      if (!result || !editor.isConnected || frame.project !== project) return;
      sheet.close();
      notice(t("ui.published_to_github_2bc4b317") + result.remote);
    } finally {
      publishingGit = false;
      byId("status-publish").disabled = false;
      if (editor.isConnected) bindLocalized(status, "textContent", () => t("ui.publish_branch_6da974a7") + (snapshot.branch ?? "HEAD"));
    }
  });
  editor.prepend(element("p", () => t("ui.publish_branch_6da974a7") + (snapshot.branch ?? "HEAD"), "muted"));
  editor.querySelector("input").focus();
}

let reviewNotifications = [];
let reviewNotificationKey = "";
let reviewNotificationRequest = 0;

function renderReviewNotifications(results = [], message = "") {
  const menu = byId("notifications");
  const statuses = new Map(results.map(entry => [entry.id, entry]));
  const labels = {
    clean: ["ui.no_git_conflicts_f66aeb42"],
    conflict: ["ui.git_conflict_48a68f12"],
    integrated: ["ui.already_integrated_in_git_ee75b991"],
    noChanges: ["ui.submitted_without_git_changes_8fe2f6e6"],
    pending: ["ui.git_operation_pending_2ff48571"],
    stale: ["ui.submission_changed_f579fee3"],
    unchecked: ["ui.git_compatibility_unchecked_12f6c4b4"],
  };
  const rows = reviewNotifications.map(task => {
    const result = statuses.get(task.id);
    const status = result?.revision === task.revision ? result.status : undefined;
    const running = frame.runningTasks?.includes(task.id);
    return { ...task, status, running,
      rank: !running && ["clean", "noChanges"].includes(status) ? 0 : ["conflict", "stale", "pending"].includes(status) ? 2 : 1 };
  }).sort((a, b) => a.rank - b.rank || (a.at ?? "").localeCompare(b.at ?? ""));
  const focusedTask = menu.contains(document.activeElement) ? document.activeElement.dataset.reviewTask : undefined;
  const items = rows.map(task => {
    const open = button("", () => {
      menu.hidePopover();
      return showTask(task.id);
    }, "quiet notification-entry");
    open.dataset.reviewTask = task.id;
    const details = [task.status && Object.hasOwn(labels, task.status) && t(...labels[task.status]),
      task.reviewApproved && t("ui.approved_by_reviewer_cb27fd26"),
      task.running && t("ui.executor_still_running_e4f5841e"), task.at && relativeCommitDate(task.at)];
    const detail = element("span", details.filter(Boolean).join(" · "));
    if (task.at) detail.title = shortDate(task.at);
    open.append(element("strong", task.id + " · " + task.title), detail);
    return open;
  });
  if (message || !items.length) {
    const status = element("p", () => message || t("ui.no_tasks_in_review_a697a250"), "muted");
    status.setAttribute("role", "status");
    items.unshift(status);
  }
  menu.replaceChildren(...items);
  if (focusedTask) items.find(item => item.dataset.reviewTask === focusedTask)?.focus({ preventScroll: true });
}

async function refreshReviewNotifications() {
  const request = ++reviewNotificationRequest;
  if (!reviewNotifications.length) return renderReviewNotifications();
  renderReviewNotifications([], t("ui.checking_git_compatibility_6eaa5008"));
  const result = await api.command("review-queue").catch(error => ({ ok: false, error }));
  if (request !== reviewNotificationRequest || !byId("notifications").matches(":popover-open")) return;
  if (result.ok) renderReviewNotifications(result.data);
  else renderReviewNotifications([], boardError(result.error));
}

function renderActiveAgents() {
  const indicator = byId("status-agents");
  const panel = byId("agent-activity");
  indicator.hidden = !frame.board;
  if (indicator.hidden) {
    panel.hidePopover();
    return;
  }
  const { total = 0, details = [] } = frame.activeAgents ?? {};
  const label = t("ui.active_agents_f885023a");
  indicator.querySelector("span").textContent = total;
  indicator.setAttribute("aria-label", label + " · " + total);
  byId("agent-activity-title").textContent = t("agentActivity.title");
  const roles = {
    manager: t("ui.manager_92a95b5c"),
    executor: t("ui.executor_92197b27"),
    reviewer: t("ui.reviewer_50c42665"),
  };
  const groups = details.map(board => {
    const group = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = board.detail ? board.name + " (" + board.detail + ")" : board.name;
    const slots = document.createElement("dl");
    for (const role of ["executor", "reviewer", "manager"]) {
      const term = document.createElement("dt");
      term.textContent = roles[role];
      const value = document.createElement("dd");
      if (role === "manager") {
        value.textContent = t(board.managerBusy ? "agentActivity.busy" : "agentActivity.idle");
      } else {
        const { used, limit } = board[role];
        value.textContent = limit ? `${used} / ${limit}` : t("agentActivity.unlimited", { used });
      }
      slots.append(term, value);
    }
    group.append(heading, slots);
    if (board.operations.length) {
      const list = document.createElement("ul");
      for (const operation of board.operations) {
        const item = document.createElement("li");
        item.textContent = [roles[operation.role], t("agentActivity." + operation.kind), operation.task]
          .filter(Boolean).join(" · ");
        list.append(item);
      }
      group.append(list);
    } else {
      const empty = document.createElement("p");
      empty.textContent = t("agentActivity.empty");
      group.append(empty);
    }
    return group;
  });
  byId("agent-activity-boards").replaceChildren(...groups);
}

function renderStatusBar(projectChanged) {
  renderActiveAgents();
  const { branch, head, tracking, remotes, pushTarget, pushError, trackingError, gitError } = frame.board?.gitInfo ?? {};
  const revision = head ? branch ?? head.slice(0, 8) : branch && t("ui.before_the_first_commit_7e00a15b");
  const item = byId("status-branch");
  const branchLabel = head && branch ? t("ui.git_branch_5fc2f4ee") : "Git";
  item.hidden = !revision;
  item.title = revision ? branchLabel + " · " + revision : "";
  item.querySelector("span").textContent = revision ?? "";
  const status = byId("status-tracking");
  status.hidden = !gitError && (!branch || !head || !remotes?.length);
  const pushingBranch = gitPushes.get(frame.project);
  status.disabled = pushingBranch !== undefined || !pushTarget;
  const pushing = !status.hidden && pushingBranch === branch;
  status.setAttribute("aria-busy", String(pushing));
  if (!status.hidden) {
    const { behind, ahead } = tracking ?? {};
    status.querySelector("span").textContent = tracking ? behind + "↓ " + ahead + "↑" : "?↓ ?↑";
    bindLocalized(status, "title", () => {
      const reason = gitError ? t("ui.git_state_unavailable") :
        pushError ? t("ui.configure_git_upstream") :
        trackingError ? t("ui.git_counts_unavailable") : t("ui.git_upstream_missing");
      if (!tracking || !pushTarget) return reason + (pushTarget ? " · " +
        t("ui.push_branch_destination") + pushTarget.remote + "/" + pushTarget.remoteRef.slice(11) : "");
      return (pushing ? t("ui.pushing_commits_c457ab7e") :
        status.disabled ? t("ui.another_branch_is_being_pushed_4961fd8c") : t("ui.push_remote_branch")) + " · " +
        t("ui.behind_2ead5b5b") + behind + " · " + t("ui.ahead_10871dc0") + ahead;
    });
    status.setAttribute("aria-label", status.title);
  }
  const publish = byId("status-publish");
  publish.hidden = !branch || !head || !remotes || remotes.length > 0 || Boolean(gitError);
  bindLocalized(publish, "title", () => t("ui.publish_to_github_5ba684aa"));
  publish.setAttribute("aria-label", publish.title);
  if (projectChanged) {
    gitMenuRequest++;
    const branches = byId("git-branches");
    if (branches.matches(":popover-open")) branches.hidePopover();
  }
  const menu = byId("notifications");
  if (projectChanged && menu.matches(":popover-open")) menu.hidePopover();
  const bell = byId("status-notifications");
  const label = t("ui.review_queue_df5dcbe5");
  const submitted = (frame.board?.tasks ?? []).filter(task => task.status === "review").map(task => {
    const at = task.submittedAt ?? task.history?.findLast(entry => entry.action === "submit" && entry.actor === "agent" && entry.to === "review")?.at;
    return { id: task.id, title: task.title, revision: task.revision, reviewApproved: task.reviewApproved, at };
  });
  bell.title = label;
  bell.setAttribute("aria-label", submitted.length ? label + " · " + submitted.length : label);
  const count = bell.querySelector(".count");
  count.textContent = submitted.length;
  count.hidden = !submitted.length;
  menu.setAttribute("aria-label", label);
  const key = JSON.stringify([frame.project, frame.localization?.locale, head, submitted, submitted.map(task => frame.runningTasks?.includes(task.id))]);
  if (reviewNotificationKey === key) return;
  reviewNotificationKey = key;
  reviewNotifications = submitted;
  if (menu.matches(":popover-open")) void refreshReviewNotifications();
}

let tabsSignature = "";
let draggedProject;

function clearTabDrop() {
  byId("project-tabs").querySelectorAll(".drop-before, .drop-after").forEach(tab => {
    tab.classList.remove("drop-before", "drop-after");
  });
}

function updateProjectTabActivity(container, tab, select = container.querySelector(".project-tab-button")) {
  const activity = tab.activity?.count ? t("ui.active_agents_f885023a") + ": " +
    [["manager", t("ui.manager_92a95b5c")], ["executor", t("ui.executor_92197b27")],
      ["reviewer", t("ui.reviewer_50c42665")]]
      .filter(([role]) => tab.activity.roles?.[role])
      .map(([role, name]) => name + " " + tab.activity.roles[role]).join(", ") : "";
  container.classList.toggle("has-active-agents", Boolean(activity));
  const description = [activity, tab.unread && t("ui.new_manager_messages_2ad2832e")].filter(Boolean).join(". ");
  select.title = [tab.path, description].filter(Boolean).join("\n");
  if (description) select.setAttribute("aria-description", description);
  else select.removeAttribute("aria-description");
}

function renderProjectTabs() {
  const bar = byId("project-tabs");
  const tabs = frame.tabs ?? [];
  const signature = JSON.stringify([tabs.map(({ activity, ...tab }) => tab), frame.project, frame.localization?.locale]);
  if (signature === tabsSignature) {
    for (const tab of tabs) {
      const container = [...bar.children].find(item => item.dataset.project === tab.path);
      if (container) updateProjectTabActivity(container, tab);
    }
    return;
  }
  tabsSignature = signature;
  const focused = bar.contains(document.activeElement) ? document.activeElement : undefined;
  const focusedPath = focused?.closest(".project-tab")?.dataset.project;
  const closeFocused = focused?.classList.contains("project-tab-close");
  bindLocalized(bar, "aria-label", () => t("ui.projects_f40f8e75"), true);
  bar.hidden = !tabs.length;
  bar.replaceChildren(...tabs.map(tab => {
    const container = element("div", undefined, "project-tab");
    container.dataset.project = tab.path;
    container.setAttribute("role", "presentation");
    const select = button("", () => api.selectTab(tab.path), "project-tab-button");
    select.className = "project-tab-button";
    select.draggable = true;
    select.addEventListener("dragstart", event => {
      draggedProject = tab.path;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-taskboard-tab", tab.path);
    });
    select.addEventListener("dragend", () => {
      draggedProject = undefined;
      clearTabDrop();
    });
    container.addEventListener("dragover", event => {
      if (!draggedProject || draggedProject === tab.path) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearTabDrop();
      const rect = container.getBoundingClientRect();
      container.classList.add(event.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
      const bounds = bar.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) bar.scrollBy(0, -20);
      else if (event.clientY > bounds.bottom - 28) bar.scrollBy(0, 20);
    });
    container.addEventListener("dragleave", event => {
      if (!container.contains(event.relatedTarget)) container.classList.remove("drop-before", "drop-after");
    });
    container.addEventListener("drop", event => {
      if (!draggedProject) return;
      event.preventDefault();
      const project = draggedProject;
      const rect = container.getBoundingClientRect();
      draggedProject = undefined;
      clearTabDrop();
      const after = event.clientY >= rect.top + rect.height / 2;
      protect(() => api.reorderTab(project, tab.path, after))();
    });
    updateProjectTabActivity(container, tab, select);
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(tab.path === frame.project));
    select.setAttribute("aria-controls", "workspace");
    select.tabIndex = tab.path === frame.project ? 0 : -1;
    select.append(element("span", tab.name, "project-tab-name"));
    if (tab.unread) {
      const dot = element("i", undefined, "icon codicon codicon-circle-filled project-tab-unread");
      dot.setAttribute("aria-hidden", "true");
      select.append(dot);
    }
    if (tab.detail) select.append(element("span", tab.detail, "project-tab-detail"));
    select.addEventListener("keydown", protect(async event => {
      const index = tabs.findIndex(entry => entry.path === tab.path);
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const after = event.key === "ArrowDown";
        const target = tabs[index + (after ? 1 : -1)];
        if (target) await api.reorderTab(tab.path, target.path, after);
        return;
      }
      let next;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else if (event.key === "Delete") {
        event.preventDefault();
        await api.closeTab(tab.path);
        bar.querySelector('[aria-selected="true"]')?.focus();
        return;
      } else return;
      event.preventDefault();
      await api.selectTab(tabs[next].path);
      bar.querySelector('[aria-selected="true"]')?.focus();
    }));
    const close = button("", () => api.closeTab(tab.path), "project-tab-close");
    close.className = "project-tab-close";
    close.append(icon("close"));
    bindLocalized(close, "aria-label", () => t("ui.close_project_b01a370f") + tab.name, true);
    close.title = close.getAttribute("aria-label");
    container.append(select, close);
    return container;
  }));
  if (focused) {
    const container = [...bar.children].find(item => item.dataset.project === focusedPath);
    const target = container?.querySelector(closeFocused ? ".project-tab-close" : ".project-tab-button")
      ?? bar.querySelector('[aria-selected="true"]');
    target?.focus();
  }
  bar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function update(next) {
  for (const binding of localizedBindings) if (!binding.node.isConnected) localizedBindings.delete(binding);
  const languageChanged = frame.localization?.locale !== next.localization?.locale;
  const previousProject = frame.project;
  const projectChanged = frame.project !== next.project;
  const previousBoard = projectChanged ? undefined : frame.board;
  const tagsChanged = JSON.stringify(frame.board?.tags) !== JSON.stringify(next.board?.tags);
  if (projectChanged && byId("auto-mode-panel").matches(":popover-open")) byId("auto-mode-panel").hidePopover();
  if ((projectChanged || frame.localization?.locale !== next.localization?.locale || Boolean(frame.board) !== Boolean(next.board)) &&
      byId("settings-menu").matches(":popover-open")) byId("settings-menu").hidePopover();
  if (next.localization) localization.install(next.localization);
  window.renderProviderLimits?.();
  frame = next;
  const languageSelect = byId("language-select");
  if (languageSelect) languageSelect.value = next.localization?.preference ?? "system";
  if (languageChanged) {
    refreshLocalizedBindings();
    for (const node of document.querySelectorAll("[data-i18n-text]")) node.textContent = t(node.dataset.i18nText);
    for (const attribute of ["aria-label", "title", "placeholder"]) {
      for (const node of document.querySelectorAll("[data-i18n-" + attribute + "]")) node.setAttribute(attribute, t(node.getAttribute("data-i18n-" + attribute)));
    }

  }
  if (byId("app-header").hidden) {
    byId("app-header").classList.toggle("titlebar", api.customTitleBar);
    mountAppMenu();
    byId("app-header").hidden = false;
  }
  if (tagsChanged) boardTags = new Map((next.board?.tags ?? []).map(tag => [tagKey(tag.name), tag]));
  applyTheme(next.theme);
  renderStatusBar(projectChanged);
  renderProjectTabs();
  if (projectChanged) {
    projectGeneration++;
    taskSheetRequest++;
    lanePreferences = switchBoardRendering(previousProject, next.project) ?? loadLanePreferences();
    archiveView = false;
    if (sheet.open) sheet.close();
  }
  if (Array.isArray(next.tabs)) {
    const openProjects = new Map(next.tabs.map(tab => [tab.path, tab.expertCatalogVersion]));
    for (const [project, view] of boardViews) {
      if (openProjects.has(project)) continue;
      view.composer[0]?.dispose?.();
      boardViews.delete(project);
    }
    let refreshExpertNames = false;
    for (const [project, catalog] of taskExpertCatalog) {
      if (!openProjects.has(project) || openProjects.get(project) !== catalog.version) {
        taskExpertCatalog.delete(project);
        if (project === next.project && openProjects.has(project)) refreshExpertNames = true;
      }
    }
    if (refreshExpertNames && sheet.open && sheetKind === "task") {
      void body.querySelector(".expert-team")?.refreshRoleNames?.();
    }
  }
  render(previousBoard);
  syncBoardNotice(projectChanged);
  const tagSettings = byId("tag-settings");
  if (tagsChanged && sheet.open && tagSettings) renderTagSettings(tagSettings);
  if (sheetKind === "review" && sheet.open && taskInSheet?.acceptanceRepair) {
    const current = frame.board?.tasks.find(task => task.id === taskInSheet.id);
    if (current && (current.revision !== taskInSheet.revision || JSON.stringify(current.acceptanceRepair) !== JSON.stringify(taskInSheet.acceptanceRepair))) {
      if (current.acceptanceRepair) void showReview({ ...taskInSheet, ...current });
      else void showTask(current.id);
    } else if (current?.acceptanceRepair) {
      const status = byId("acceptance-repair-status");
      const label = acceptanceRepairStatus(current.id, current.acceptanceRepair);
      if (status && status.textContent !== label) status.textContent = label;
    }
  }
  if (sheetKind === "review" && sheet.open && taskInSheet && !taskInSheet.acceptanceRepair) {
    const current = frame.board?.tasks.find(task => task.id === taskInSheet.id);
    const previous = previousBoard?.tasks.find(task => task.id === current?.id);
    const previousMode = previous?.reviewModeOverride?.mode ?? previousBoard?.settings.reviewMode;
    const currentMode = current?.reviewModeOverride?.mode ?? frame.board?.settings.reviewMode;
    const previousVersion = previous?.reviewModeOverride?.version ?? previousBoard?.settings.reviewModeVersion;
    const currentVersion = current?.reviewModeOverride?.version ?? frame.board?.settings.reviewModeVersion;
    if (current && (previousMode !== currentMode || ((previousMode === "reviewer-human" || currentMode === "reviewer-human") &&
        (current.revision !== previous?.revision || current.reviewApproved !== previous?.reviewApproved ||
         current.reviewTargetHead !== previous?.reviewTargetHead || previousVersion !== currentVersion)))) {
      if (current.status === "review") void showReview({ ...taskInSheet, ...current }, body.querySelector("[name=message]")?.value);
      else void showTask(current.id);
    }
  }
  if (sheetKind === "task" && sheet.open && taskInSheet) {
    byId("task-side").firstElementChild?.syncAgentState?.();
    const runStatus = byId("task-agent-run");
    if (runStatus) renderAgentRunStatus(runStatus, frame.board?.tasks.find(task => task.id === taskInSheet.id) ?? taskInSheet);
    const launch = byId("task-launch");
    if (launch) {
      launch.hidden = frame.runningTasks?.includes(taskInSheet.id) ?? false;
      launch.disabled = Boolean(frame.quotaWait || taskInSheet.unfinishedDependencies?.length);
    }
    if (tagsChanged) byId("task-sheet-tags")?.replaceChildren(...tagBadges(taskInSheet.tags));
    const task = frame.board?.tasks.find(entry => entry.id === taskInSheet.id);
    const archived = frame.board?.archived.find(entry => entry.id === taskInSheet.id);
    const cleaned = taskInSheet.cleanupAvailable && frame.board?.cleanedTasks?.includes(taskInSheet.id);
    if (Boolean(byId("task-unconfirmed-launch")) !== showUnconfirmedLaunch(taskInSheet) ||
        Boolean(byId("task-stop-waiting")) !== Boolean(frame.waitingTasks?.includes(taskInSheet.id)) ||
        previousBoard?.settings.reviewMode !== frame.board?.settings.reviewMode ||
        JSON.stringify(previousBoard?.settings.manualColumns) !== JSON.stringify(frame.board?.settings.manualColumns) || cleaned || (task && (task.revision !== taskInSheet.revision ||
        (task.historyLength ?? task.history?.length) !== taskInSheet.history.length ||
        String(task.unfinishedDependencies) !== String(taskInSheet.unfinishedDependencies))) ||
        (archived && !task && (archived.status !== taskInSheet.status ||
          (archived.tags && JSON.stringify(archived.tags) !== JSON.stringify(taskInSheet.tags))))) {
      void protect(() => showTask(taskInSheet.id))();
    }
  }
}

byId("welcome-create").addEventListener("click", protect(createBoard));
byId("git-branches").addEventListener("toggle", protect(event => {
  gitMenuKeys.abort();
  gitMenuKeys = new AbortController();
  if (event.newState === "open") return openGitBranches();
  gitMenuRequest++;
}));
byId("status-publish").addEventListener("click", protect(publishToGitHub));
byId("status-tracking").addEventListener("click", protect(pushTrackedBranch));
let savingAutoMode = false;
const autoModeSwitch = byId("auto-mode-switch");
const goalHint = byId("iterative-goal-hint");
const goalRule = byId("iterative-goal-rule");
const goalEvents = byId("iterative-goal-events");
const goalLastRun = byId("iterative-goal-last-run");

function renderAutoMode() {
  const settings = frame.board?.settings;
  const goal = frame.goalIteration;
  autoModeSwitch.checked = settings?.autoMode === true;
  autoModeSwitch.disabled = savingAutoMode;
  let rule = "";
  let hint;
  const events = [];
  let lastRun = "";
  const formatDuration = milliseconds => {
    const seconds = milliseconds / 1000;
    const unit = seconds % 3600 === 0 ? "hour" : seconds % 60 === 0 ? "minute" : "second";
    const divisor = { hour: 3600, minute: 60, second: 1 }[unit];
    return new Intl.NumberFormat(localization.locale, { style: "unit", unit, unitDisplay: "long" })
      .format(seconds / divisor);
  };
  const scopeLabel = scope => scope === "board" ? t("autoMode.eventBoard") : scope;
  const formatTime = value => new Date(value).toLocaleString(localization.locale, {
    ...(new Date(value).toDateString() === new Date().toDateString() ? {} : { dateStyle: "medium" }),
    timeStyle: "medium",
  });
  if (!goal || goal.status === "complete") {
    hint = t("autoMode.goalRequired");
  } else {
    rule = t(goal.enabled ? "autoMode.enabled" : "autoMode.disabled");
    if (goal.intervalMs) {
      rule += " · " + t("autoMode.interval", { duration: formatDuration(goal.intervalMs) });
    } else if (goal.enabled && !goal.rules?.length) {
      rule += " · " + t("autoMode.queue");
    }
    for (const event of goal.rules ?? []) {
      const scope = scopeLabel(event.scope);
      if (event.kind === "reserve") {
        const threshold = event.threshold === "multiplier" ? t("autoMode.eventMultiplier", {
          value: event.value, target: event.value * goal.executorLimit,
        }) : event.value;
        events.push(t("autoMode.eventReserve", { scope, threshold }));
      } else {
        const label = t("autoMode.event." + event.kind);
        events.push(scope + " — " + label + (event.kind === "idle" ? " " + formatDuration(event.durationMs) : ""));
      }
    }
    if (goal.lastRun?.length) {
      const reasons = goal.lastRun.map(reason => {
        if (reason.kind === "reserve") return t("autoMode.reasonReserve", reason);
        const label = t("autoMode.event." + reason.kind);
        return reason.scope ? scopeLabel(reason.scope) + " — " + label : label;
      });
      lastRun = t("autoMode.lastRun", { reasons: reasons.join(" · ") });
    }
    const now = Date.now();
    if (goal.status === "paused") {
      hint = t("autoMode.paused");
    } else if (!goal.enabled) {
      hint = t(goal.running ? "autoMode.running" : "autoMode.manual");
    } else if (!settings?.autoMode) {
      hint = t("autoMode.autoOff");
    } else if (frame.quotaWait) {
      hint = t("autoMode.quota");
    } else if (goal.status !== "active") {
      hint = t("autoMode.manual");
    } else if (goal.running) {
      hint = t("autoMode.running");
    } else if (goal.retryAt > now) {
      hint = t("autoMode.retry", { time: formatTime(goal.retryAt) });
    } else if (goal.nextAt > now) {
      hint = t(goal.rules?.length ? "autoMode.waitingOrInterval" : "autoMode.next", { time: formatTime(goal.nextAt) });
    } else {
      hint = t(goal.intervalMs ? "autoMode.due" : goal.rules?.length ? "autoMode.waitingForEvent" : "autoMode.waitingForWork");
    }
  }
  if (goalRule.textContent !== rule) {
    goalRule.textContent = rule;
  }
  if (JSON.stringify([...goalEvents.children].map(item => item.textContent)) !== JSON.stringify(events)) {
    goalEvents.replaceChildren(...events.map(label => {
      const item = document.createElement("li");
      item.textContent = label;
      return item;
    }));
  }
  goalEvents.hidden = !events.length;
  goalLastRun.hidden = !lastRun;
  if (goalLastRun.textContent !== lastRun) goalLastRun.textContent = lastRun;
  if (goalHint.textContent !== hint) {
    goalHint.textContent = hint;
  }
}

async function saveAutoMode(input) {
  savingAutoMode = true;
  renderAutoMode();
  try {
    await command("settings", undefined, input);
  } finally {
    savingAutoMode = false;
    renderAutoMode();
  }
}

autoModeSwitch.addEventListener("change", protect(() => saveAutoMode({ autoMode: autoModeSwitch.checked })));
byId("app-settings").setAttribute("aria-haspopup", "menu");
byId("app-settings").setAttribute("aria-controls", "settings-menu");
byId("app-settings").setAttribute("aria-expanded", "false");
byId("app-settings").addEventListener("click", () => openSettingsMenu());
byId("app-settings").addEventListener("keydown", event => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  openSettingsMenu(event.key === "ArrowUp");
});
byId("settings-menu").addEventListener("beforetoggle", event => {
  byId("app-settings").setAttribute("aria-expanded", String(event.newState === "open"));
});
byId("settings-menu").addEventListener("toggle", event => {
  if (event.newState === "closed" && (document.activeElement === document.body ||
      event.currentTarget.contains(document.activeElement))) byId("app-settings").focus();
});
byId("settings-menu").addEventListener("keydown", event => {
  const menu = event.currentTarget;
  if (event.key === "Escape" || event.key === "Tab") {
    menu.hidePopover();
    byId("app-settings").focus();
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...menu.querySelectorAll("button:not(:disabled):not([hidden])")];
  const index = items.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus();
});
window.addEventListener("resize", () => {
  const menu = byId("settings-menu");
  if (menu.matches(":popover-open")) menu.hidePopover();
});
byId("notifications").addEventListener("toggle", event => {
  if (event.newState === "open") void refreshReviewNotifications();
  else reviewNotificationRequest++;
});
byId("welcome-open").addEventListener("click", protect(() => api.open()));
byId("welcome-restore").addEventListener("click", protect(backupSettings));
byId("notice-close").addEventListener("click", () => {
  if (displayedBoardError) dismissedBoardErrors.set(frame.project, displayedBoardError);
  windowNotice();
});
byId("close-sheet").addEventListener("click", () => sheet.close());
byId("lanes").addEventListener("click", () => byId("board-composer").firstChild?.closeChat(), { capture: true });
document.addEventListener("pointerdown", event => {
  for (const menu of document.querySelectorAll(".lane-filter[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    const menu = document.querySelector(".lane-filter[open]");
    if (menu) { menu.open = false; menu.querySelector("summary").focus(); }
  }
});
sheet.addEventListener("close", () => {
  if (sheet.open) return;
  chatPreviews.disconnect();
  byId("task-side").replaceChildren();
  taskSheetRequest++;
  sheetKind = "";
  taskInSheet = undefined;
  byId("app-content").inert = false;
  document.querySelector(".status-bar").inert = false;
  if (document.activeElement === document.body || sheet.contains(document.activeElement)) focusBeforeSheet?.focus({ preventScroll: true });
  focusBeforeSheet = undefined;
});
api.subscribe(update);
api.onChatUpdate(updateChat);
window.addEventListener("focus", () => {
  const composer = byId("board-composer").firstChild;
  composer?.invalidateHistory?.();
  composer?.syncManagerUnread?.(frame.managerUnread);
});
const syncManagerRead = () => byId("board-composer").firstChild?.syncManagerUnread?.(frame.managerUnread);
document.addEventListener("visibilitychange", () => {
  syncManagerRead();
});
document.addEventListener("close", syncManagerRead, true);
reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  for (const animation of byId("lanes").getAnimations({ subtree: true })) {
    if (animation.id === "task-card-move" || animation.id === "task-card-enter") animation.cancel();
  }
});
api.onTheme(theme => {
  frame.theme = theme;
  applyTheme(theme);
});
byId("update-release").addEventListener("click", event => {
  event.preventDefault();
  void api.openLink(event.currentTarget.href);
});
async function closeUpdateDialog(event) {
  event.preventDefault();
  const { phase, candidate } = appUpdate;
  if (phase === "discarding") return;
  if (phase === "ready" || phase === "error" || phase === "cleanup-error") {
    if (!await api.discardUpdate(candidate.version)) {
      if (updateDialog.open) byId("update-later").focus();
      return;
    }
  }
  updateDialog.close();
}
byId("update-later").addEventListener("click", event => {
  void closeUpdateDialog(event).catch(error => notice(error.message));
});
updateDialog.addEventListener("cancel", event => {
  void closeUpdateDialog(event).catch(error => notice(error.message));
});
byId("update-action").addEventListener("click", () => {
  const version = appUpdate.candidate.version;
  if (appUpdate.phase === "ready") {
    void api.confirmUpdate(version);
  } else {
    void api.downloadUpdate(version);
  }
});
function receiveAppUpdate(state) {
  appUpdate = state;
  if (frame.localization) renderAppUpdate();
}
api.onUpdateChanged?.(receiveAppUpdate);
api.bootstrap().then(initial => {
  update(initial);
  return api.updateState?.().then(state => {
    if (!appUpdate) receiveAppUpdate(state);
  });
}).catch(error => notice(error.message, t("ui.application_startup_a6ae49b2")));

function createBoard() {
  openSheet("board-type", "Создать доску");
  body.append(element("p", "Выберите тип доски. После создания его нельзя изменить.", "muted"));
  const choices = element("div", undefined, "form");
  for (const [type, title, description] of [
    ["agent", "Доска для агентов", "Задачи выполняют агенты. Вы задаёте результат и проверяете работу."],
    ["manual", "Обычная доска", "Дела выполняете вы, а ИИ помогает их создавать и редактировать."],
  ]) {
    const choice = button("", async () => {
      for (const control of choices.querySelectorAll("button")) control.disabled = true;
      try {
        const result = await api.createBoard(type);
        if (result?.ok === false) return notice(boardError(result.error));
        if (sheetKind === "board-type") sheet.close();
      } finally { for (const control of choices.querySelectorAll("button")) control.disabled = false; }
    }, "board-type-choice");
    choice.dataset.boardType = type;
    choice.append(element("strong", title), element("span", description));
    choices.append(choice);
  }
  body.append(choices, button("Отмена", () => sheet.close()));
  choices.querySelector("button").focus();
}

function createManualTask(status) {
  const column = manualColumns().find(c => c.id === status);
  if (!manualBoard() || !column) return;
  const project = frame.project;
  const generation = projectGeneration;
  const editor = form("manual-create", "Создать задачу · " + column.name, [
    { name: "title", label: "Название", required: true },
    { name: "description", label: "Описание", type: "area" },
  ], "Создать задачу", async values => {
    if (project !== frame.project || generation !== projectGeneration) return;
    const created = await command("create", undefined, { title: values.title, description: values.description, initialStatus: status });
    if (created && editor.isConnected && sheetKind === "manual-create") sheet.close();
  });
  editor.querySelector("input").focus();
}

function manualBoardSettings() {
  const previous = structuredClone(manualColumns());
  const columns = structuredClone(previous);
  const moves = {};
  function render() {
    openSheet("board-settings", "Обычная доска · Колонки");
    body.append(element("p", "Вы сами меняете статусы дел. Отметьте колонку завершения. Авторежим недоступен; тип доски изменить нельзя."));
    columns.forEach((column, index) => {
      const row = element("section", undefined, "form");
      const identity = element("div", undefined, "sheet-actions");
      const controls = element("div", undefined, "sheet-actions");
      const name = element("input"); name.value = column.name; name.setAttribute("aria-label", "Название колонки");
      name.style.flex = "1"; name.style.minWidth = "0";
      name.addEventListener("input", () => column.name = name.value);
      const color = element("input"); color.type = "color"; color.value = column.color; color.setAttribute("aria-label", "Цвет колонки");
      color.addEventListener("input", () => column.color = color.value);
      const terminal = element("input"); terminal.type = "checkbox"; terminal.checked = column.terminal;
      terminal.addEventListener("change", () => column.terminal = terminal.checked);
      const end = element("label", "Завершение", "form-checkbox"); end.prepend(terminal);
      identity.append(name, color);
      row.append(identity, end, controls);
      for (const [delta, caption] of [[-1, "Выше"], [1, "Ниже"]]) {
        const move = button(caption, () => { [columns[index], columns[index + delta]] = [columns[index + delta], columns[index]]; render(); });
        move.disabled = !columns[index + delta]; controls.append(move);
      }
      controls.append(button("Удалить", () => {
        if (columns.length === 1) return notice("Нужна хотя бы одна колонка.");
        const targets = columns.filter(c => c.id !== column.id);
        const occupied = frame.board.tasks.some(t => t.status === column.id) || Object.values(moves).includes(column.id);
        if (occupied) {
          form("column-delete", "Куда перенести дела?", [{ name: "target", label: "Оставшаяся колонка", options: [["", "Выберите колонку"], ...targets.map(c => [c.id, c.name])], required: true }], "Перенести и удалить", async value => {
            if (!targets.some(c => c.id === value.target)) return;
            moves[column.id] = value.target;
            for (const key of Object.keys(moves)) if (moves[key] === column.id) moves[key] = value.target;
            columns.splice(index, 1); render();
          });
        } else { columns.splice(index, 1); render(); }
      }));
      body.append(row);
    });
    body.append(button("Добавить колонку", () => { columns.push({ id: "manual:" + crypto.randomUUID(), name: "Новая колонка", color: "#818CF8", terminal: false }); render(); }));
    body.append(button("Сохранить колонки", async () => {
      if (await command("manual-columns", undefined, { previous, columns, moves })) sheet.close();
    }, "primary"));
  }
  render();
}
