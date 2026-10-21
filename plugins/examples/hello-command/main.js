// Trellora sample plugin: hello-command
// 演示插件：hello-command
//
// Registers one sidebar command. Demonstrates:
//   - L0 core APIs (log, events)
//   - L1 capability API (ui.registerCommand, permission: ui:command)
//
// 入口约定：导出 { activate, deactivate } 对象（或 CommonJS module.exports）。

/** @type {import('../../sdk/trellora-plugin-sdk').TrelloraPlugin} */
module.exports = {
  activate(context) {
    const { manifest, log, ui, events } = context;

    log.info(`hello-command activating (id=${manifest.id}, v=${manifest.version})`);

    ui.registerCommand({
      id: 'hello-command:say-hello',
      title: 'Say Hello',
      panel: 'sidebar',
      execute: (args) => {
        log.info(`Say Hello invoked (trigger=${args.trigger})`);
        events.emit('hello-command:greeted', { at: Date.now() });
      },
    });

    log.info('hello-command ready');
  },

  deactivate() {
    // Nothing to clean up: the host unregisters commands automatically.
  },
};
