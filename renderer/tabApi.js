// One connection's view of window.api: the MQTT calls, pop-outs and child
// window resets name that connection, so views written for one connection
// (inspector, plots, publisher, subscriptions dialog) keep calling
// api.publish(msg), api.openPopout(topic, history) and so on unchanged.
// Every other api member is passed through.

export function bindConnection(api, connId, { name }) {
  // "<profile name> — <what>", or just <what> before the tab has a profile.
  const title = (what) => (name() ? `${name()} — ${what}` : what);
  return {
    ...api,
    connect: (profile) => api.connect(connId, profile),
    bind: (profile) => api.bind(connId, profile),
    disconnect: () => api.disconnect(connId),
    status: () => api.status(connId),
    publish: (msg) => api.publish(connId, msg),
    subscribe: (topic, qos) => api.subscribe(connId, topic, qos),
    unsubscribe: (topic) => api.unsubscribe(connId, topic),
    subscriptions: () => api.subscriptions(connId),
    openPopout: (topic, history) => api.openPopout({ connId, topic, title: title(topic), history }),
    openPlotWindow: (init) => api.openPlotWindow({ ...init, connId, title: title(init.plot.title) }),
    resetChildWindows: () => api.resetChildWindows(connId),
  };
}
