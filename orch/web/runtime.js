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
  function dispatchKey(e) { const f = e.currentTarget._onkeydown; if (typeof f === 'function') f(e); }
  // 其余 on* 事件(oninput/onchange/onkeyup)通用分发:原先只认 onclick/onkeydown,模板里这些属性会被当普通字符串
  // setAttribute(函数源码文本)→ 输入筛选/自动增高/文件导入 onchange 全部静默失效
  function dispatchEvt(e) { const f = e.currentTarget._evh && e.currentTarget._evh[e.type]; if (typeof f === 'function') f(e); }
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
    // SVG 子树必须用 SVG 命名空间创建,否则 path 等元素不渲染
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const el = (tag === 'svg' || target.namespaceURI === SVG_NS)
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
    for (const attr of node.attributes) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name === 'onclick') {
        // handler 存节点属性,监听器读当前值;morph 会同步,避免列表重排后点错
        el._onclick = resolve(strip(val), scopes);
        el.addEventListener('click', dispatchClick); el._clickBound = true;
      } else if (name === 'onkeydown') {
        el._onkeydown = resolve(strip(val), scopes);
        el.addEventListener('keydown', dispatchKey); el._keyBound = true;
      } else if (name === 'oninput' || name === 'onchange' || name === 'onkeyup') {
        const evt = name.slice(2);
        (el._evh = el._evh || {})[evt] = resolve(strip(val), scopes);
        el.addEventListener(evt, dispatchEvt); (el._evhBound = el._evhBound || {})[evt] = true;
      } else if (name === 'style-hover') {
        el._hover = val;
        el.addEventListener('mouseenter', enterHover);
        el.addEventListener('mouseleave', leaveHover);
      } else if (name === 'ref') {
        const fn = resolve(strip(val), scopes);
        if (typeof fn === 'function') el._refFn = fn; // 存节点上;morph 后对 DOM 里真实节点执行(见 runRef/morphNode),不再对游离 frag 节点执行
      } else if (name.indexOf('hint-') === 0) {
        // 忽略 design-canvas 的占位提示属性
      } else {
        el.setAttribute(name, val.indexOf('{{') >= 0 ? interp(val, scopes) : val);
      }
    }
    renderInto([...node.childNodes], el, scopes, refs);
    target.appendChild(el);
  }

  // 对真实挂载的节点(及子树)执行 ref 回调:morph 复用旧节点、丢弃 frag 新节点,ref 必须作用在 DOM 里的真节点上
  function runRef(node) { if (node.nodeType === 1) { if (node._refFn) node._refFn(node); for (const c of node.childNodes) runRef(c); } }
  // 最小 DOM morph:按位置对齐,原地改文本/属性,结构不同才替换。
  // 保留旧节点 → 不抖动;旧节点上首渲染挂的 click/hover 监听器为稳定闭包,继续可用。
  function morph(oldP, newP) {
    const oldKids = [...oldP.childNodes];
    const newKids = [...newP.childNodes];
    const n = Math.max(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++) {
      const o = oldKids[i], nw = newKids[i];
      if (!nw) { if (o) oldP.removeChild(o); continue; }
      if (!o) { oldP.appendChild(nw); runRef(nw); continue; } // 新增节点入 DOM → 执行其 ref
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
      const nm = na[i].name, nv = na[i].value;
      if (nm === 'style' && o.hasAttribute('data-base')) { // 处于 hover 态:新 base 存 data-base,当前 style 保持 base+hover,别把悬停高亮抹掉
        if (o.getAttribute('data-base') !== nv) { o.setAttribute('data-base', nv); o.setAttribute('style', nv + ';' + (o._hover || '')); }
        continue;
      }
      if (o.getAttribute(nm) !== nv) o.setAttribute(nm, nv);
    }
    o._onclick = nw._onclick; // 同步最新 handler 到保留的旧节点
    o._onkeydown = nw._onkeydown;
    o._evh = nw._evh;
    o._hover = nw._hover;
    o._refFn = nw._refFn;
    if (o._onclick && !o._clickBound) { o.addEventListener('click', dispatchClick); o._clickBound = true; } // 无监听器旧节点被对齐到带 onClick 的新节点:补绑,否则点击无反应
    if (o._onkeydown && !o._keyBound) { o.addEventListener('keydown', dispatchKey); o._keyBound = true; }
    if (o._evh) for (const k in o._evh) { if (!o._evhBound || !o._evhBound[k]) { o.addEventListener(k, dispatchEvt); (o._evhBound = o._evhBound || {})[k] = true; } } // 通用 on* 同步补绑
    if (o._refFn) o._refFn(o); // ref 作用在保留的真实节点上(修:原来在游离 frag 节点上,滚动/聚焦等失效)
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
      const frag = document.createDocumentFragment();
      renderInto([...this._tpl.content.childNodes], frag, [vals], []);
      if (!this._root.firstChild) {
        this._root.appendChild(frag); // 首次:直接挂
        [...this._root.childNodes].forEach(runRef); // 节点即真实,执行 ref
      } else {
        morph(this._root, frag); // 后续:原地 diff;morph 内对复用/新增节点执行 ref(不再对游离节点)
      }
    }
  }

  global.RT = { Component, render: renderInto };
})(window);
