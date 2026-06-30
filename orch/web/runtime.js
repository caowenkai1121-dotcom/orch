// 迷你 dc 模板运行时:解释 sc-for / sc-if / {{ }} / onClick / style-hover / ref。
// 把 Claude design-canvas 原型(.dc.html)的模板和 Component 类几乎原样跑起来。
(function (global) {
  // 在作用域链里解析 "acc" / "m.k" / "true" 这类简单路径
  function resolve(token, scopes) {
    token = token.trim();
    if (token === 'true') return true;
    if (token === 'false') return false;
    const parts = token.split('.');
    for (let i = scopes.length - 1; i >= 0; i--) {
      const sc = scopes[i];
      if (sc && Object.prototype.hasOwnProperty.call(sc, parts[0])) {
        let v = sc[parts[0]];
        for (let j = 1; j < parts.length; j++) v = v == null ? undefined : v[parts[j]];
        return v;
      }
    }
    return undefined;
  }
  const strip = (s) => s.replace(/[{}]/g, '');
  function dispatchClick(e) { const f = e.currentTarget._onclick; if (typeof f === 'function') f(e); }
  function enterHover(e) {
    const el = e.currentTarget;
    el.setAttribute('data-base', el.getAttribute('style') || '');
    el.setAttribute('style', (el.getAttribute('style') || '') + ';' + (el._hover || ''));
  }
  function leaveHover(e) {
    const el = e.currentTarget;
    el.setAttribute('style', el.getAttribute('data-base') || '');
    el.removeAttribute('data-base');
  }
  function interp(str, scopes) {
    return str.replace(/\{\{([^}]+)\}\}/g, (m, t) => {
      const v = resolve(t, scopes);
      return v == null ? '' : String(v);
    });
  }
  function renderInto(srcNodes, target, scopes, refs) {
    srcNodes.forEach((node) => renderNode(node, target, scopes, refs));
  }
  function renderNode(node, target, scopes, refs) {
    if (node.nodeType === 3) { // text
      const raw = node.nodeValue;
      if (raw.indexOf('{{') >= 0) target.appendChild(document.createTextNode(interp(raw, scopes)));
      else target.appendChild(document.createTextNode(raw));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-if') {
      if (resolve(strip(node.getAttribute('value')), scopes)) {
        renderInto([...node.childNodes], target, scopes, refs);
      }
      return;
    }
    if (tag === 'sc-for') {
      const list = resolve(strip(node.getAttribute('list')), scopes) || [];
      const as = node.getAttribute('as');
      const kids = [...node.childNodes];
      list.forEach((item) => {
        const sc = {}; sc[as] = item;
        renderInto(kids, target, scopes.concat([sc]), refs);
      });
      return;
    }
    const el = document.createElement(tag);
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name === 'onclick') {
        // handler 存节点属性,监听器读当前值;morph 会同步,避免列表重排后点错
        el._onclick = resolve(strip(val), scopes);
        el.addEventListener('click', dispatchClick);
      } else if (name === 'style-hover') {
        el._hover = val;
        el.addEventListener('mouseenter', enterHover);
        el.addEventListener('mouseleave', leaveHover);
      } else if (name === 'ref') {
        const fn = resolve(strip(val), scopes);
        if (typeof fn === 'function') refs.push(() => fn(el));
      } else if (name.indexOf('hint-') === 0) {
        // 忽略 design-canvas 的占位提示属性
      } else {
        el.setAttribute(name, val.indexOf('{{') >= 0 ? interp(val, scopes) : val);
      }
    }
    renderInto([...node.childNodes], el, scopes, refs);
    target.appendChild(el);
  }

  // 最小 DOM morph:按位置对齐,原地改文本/属性,结构不同才替换。
  // 保留旧节点 → 不抖动;旧节点上首渲染挂的 click/hover 监听器为稳定闭包,继续可用。
  function morph(oldP, newP) {
    const oldKids = [...oldP.childNodes];
    const newKids = [...newP.childNodes];
    const n = Math.max(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++) {
      const o = oldKids[i], nw = newKids[i];
      if (!nw) { if (o) oldP.removeChild(o); continue; }
      if (!o) { oldP.appendChild(nw); continue; }
      morphNode(o, nw);
    }
  }
  function morphNode(o, nw) {
    if (o.nodeType !== nw.nodeType || o.nodeName !== nw.nodeName) { o.replaceWith(nw); return; }
    if (o.nodeType === 3) { if (o.nodeValue !== nw.nodeValue) o.nodeValue = nw.nodeValue; return; }
    if (o.nodeType !== 1) return;
    const oa = o.attributes;
    for (let i = oa.length - 1; i >= 0; i--) {
      const nm = oa[i].name;
      if (nm === 'data-base') continue; // 别动 hover 临时态
      if (!nw.hasAttribute(nm)) o.removeAttribute(nm);
    }
    const na = nw.attributes;
    for (let i = 0; i < na.length; i++) {
      if (o.getAttribute(na[i].name) !== na[i].value) o.setAttribute(na[i].name, na[i].value);
    }
    o._onclick = nw._onclick; // 同步最新 handler 到保留的旧节点
    o._hover = nw._hover;
    morph(o, nw);
  }

  class Component {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) {
      if (typeof patch === 'function') patch = patch(this.state);
      Object.assign(this.state, patch);
      this._render();
    }
    mount(root, tpl) {
      this._root = root; this._tpl = tpl;
      if (this.componentDidMount) this.componentDidMount();
      this._render();
    }
    _render() {
      const vals = this.renderVals();
      const refs = [];
      const frag = document.createDocumentFragment();
      renderInto([...this._tpl.content.childNodes], frag, [vals], refs);
      if (!this._root.firstChild) {
        this._root.appendChild(frag); // 首次:直接挂
      } else {
        morph(this._root, frag); // 后续:原地 diff,避免整树重建导致的抖动
      }
      refs.forEach((f) => f());
    }
  }

  global.RT = { Component, render: renderInto };
})(window);
