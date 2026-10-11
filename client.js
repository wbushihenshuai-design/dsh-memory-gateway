window.__ModuleLoader__.load({
  id: 'dsh-memory-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PLUGIN_ID = 'dsh-memory-gateway'
    const KIND = 'weknora'
    const WEKNORA_URL = 'https://kb.tiggo.autos/platform/knowledge-bases'
    const NAMESPACE = 'localWeKnora'
    const copy = {
      zh: {
        open: '在右侧打开 WeKnora',
        noSession: '请先打开一个会话，再打开 WeKnora',
        description: '在 DSH 内使用知识库',
        reload: '重新加载 WeKnora',
        external: '在外部浏览器打开',
        loading: '正在加载 WeKnora…',
        hint: '仅内网可访问；首次使用请在此面板登录。可使用右上角全屏按钮扩大视图。',
        unavailable: '若页面未显示，请确认当前设备可访问 kb.tiggo.autos，然后重新加载。',
      },
      en: {
        open: 'Open WeKnora in the right sidebar',
        noSession: 'Open a session before opening WeKnora',
        description: 'Use the knowledge base inside DSH',
        reload: 'Reload WeKnora',
        external: 'Open in external browser',
        loading: 'Loading WeKnora…',
        hint: 'LAN access only; sign in here on first use. Use the top-right fullscreen button for more space.',
        unavailable: 'If the page is blank, check this device can reach kb.tiggo.autos, then reload.',
      },
    }

    function WeKnoraIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z' }),
        h('path', { d: 'M4 5.5v16M8 7h8M8 11h8M8 15h5' }),
      )
    }

    const styles = `
      .weknora-control { appearance:none; font:inherit; color:var(--dsw-alias-label-secondary); background:transparent; border:1px solid transparent; border-radius:8px; cursor:pointer; }
      .weknora-control:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
      .weknora-control:focus-visible { outline:2px solid var(--dsw-alias-label-primary); outline-offset:-2px; }
      .weknora-control:disabled { opacity:.5; cursor:not-allowed; }
      .weknora-footer { display:flex; align-items:center; box-sizing:border-box; flex:0 0 auto; gap:10px; width:100%; height:36px; min-width:0; font-size:13px; font-weight:500; line-height:20px; }
      .weknora-panel { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--dsw-alias-label-primary); }
      .weknora-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 10px; flex:0 0 auto; font-size:12px; }
      .weknora-toolbar .weknora-control { padding:5px 8px; }
      .weknora-origin { color:var(--dsw-alias-label-secondary); margin-right:auto; }
      .weknora-hint { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; padding:0 10px 6px; }
      .weknora-frame { display:block; width:100%; height:100%; min-height:0; flex:1 1 auto; border:0; }
    `

    function WeKnoraButton({ wide, useMounted, openWeKnora, t }) {
      const enabled = useMounted(sessionId => sessionId !== undefined)
      return h(React.Fragment, null,
        h('style', null, styles),
        h('button', {
          type: 'button', className: 'weknora-control weknora-footer',
          disabled: !enabled, onClick: openWeKnora,
          title: t(enabled ? 'open' : 'noSession'),
          'aria-label': t(enabled ? 'open' : 'noSession'),
          'data-weknora-launcher': true,
          style: { justifyContent: wide ? 'flex-start' : 'center', padding: wide ? '0 12px' : '0' },
        },
          h(WeKnoraIcon, { size: wide ? 17 : 18 }),
          wide ? h('span', null, 'WeKnora') : null,
        ),
      )
    }

    function WeKnoraPanel({ useTabInfo, t }) {
      const { tab } = useTabInfo()
      const [generation, setGeneration] = React.useState(0)
      const [pending, setPending] = React.useState(true)
      const [notice, setNotice] = React.useState(false)
      const refresh = React.useCallback(() => {
        setPending(true)
        setNotice(false)
        setGeneration(value => value + 1)
      }, [])
      React.useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh])
      React.useEffect(() => {
        if (!pending) return
        const timer = setTimeout(() => setNotice(true), 15000)
        return () => clearTimeout(timer)
      }, [pending, generation])
      // No credentials, tokens, or parent storage cross this origin boundary.
      // Keep src/key independent of tab visibility/navigation so keepMounted
      // preserves WeKnora's route and in-progress forms when switching tabs.
      return h('section', { className: 'weknora-panel', 'aria-label': 'WeKnora', 'data-weknora-panel': true },
        h('style', null, styles),
        h('div', { className: 'weknora-toolbar' },
          h(WeKnoraIcon, { size: 16 }),
          h('span', { className: 'weknora-origin' }, 'kb.tiggo.autos'),
          h('button', { type: 'button', className: 'weknora-control', onClick: refresh, title: t('reload'), 'aria-label': t('reload') }, '↻'),
          h('a', { className: 'weknora-control', href: WEKNORA_URL, target: '_blank', rel: 'noopener noreferrer', title: t('external'), 'aria-label': t('external') }, '↗'),
        ),
        h('div', { className: 'weknora-hint' }, t('hint')),
        pending ? h('div', { className: 'weknora-hint', role: 'status' }, t(notice ? 'unavailable' : 'loading')) : null,
        h('iframe', {
          key: generation, src: WEKNORA_URL, title: 'WeKnora',
          className: 'weknora-frame', referrerPolicy: 'no-referrer',
          sandbox: 'allow-scripts allow-forms allow-same-origin allow-downloads',
          allow: 'clipboard-write',
          onLoad: () => setPending(false),
          onError: () => { setPending(true); setNotice(true) },
        }),
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NAMESPACE)
        ctx.effect(() => ctx.locale.register(NAMESPACE, copy), 'weknora: translations')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: PLUGIN_ID, kind: KIND, title: () => 'WeKnora', keepMounted: true,
          guide: [{ id: 'weknora', order: 35, title: () => 'WeKnora', description: () => t('description'), icon: WeKnoraIcon }],
        }), 'weknora: right-sidebar tab')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: PLUGIN_ID, locale: NAMESPACE,
        }, WeKnoraPanel)), 'weknora: embedded page')
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'dsh-memory-gateway', order: 10,
          locale: NAMESPACE,
          inject: () => ({
            hooks: { mounted: ctx.sidebarRight.mounted },
            openWeKnora: () => {
              if (ctx.sidebarRight.mounted.getSnapshot() === undefined) return
              ctx.sidebarRight.openTab(KIND)
            },
          }),
        }, WeKnoraButton)), 'weknora: sidebar launcher')
      },
    }
  },
})
