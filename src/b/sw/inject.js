const SHARED_SCRIPT = `
<script>
(function(){
  var P='${MOCHI_PREFIX}',S=${isFolio||false},K='q7Zx!9pL';
  var X=function(s){var o='';for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^K.charCodeAt(i%K.length));return o;};
  var D=function(h){
    if(!h)return h;
    try{
      var u=new URL(h,location.origin);
      if(u.pathname.indexOf(P)===0){
        var q=u.pathname.slice(P.length);
        if(q.slice(-1)==='/')q=q.slice(0,-1);
        try{
          var r=q.replace(/-/g,'+').replace(/_/g,'/');
          while(r.length%4)r+='=';
          var d=X(atob(r));
          d=decodeURIComponent(d);
          if(d.indexOf('http://')===0||d.indexOf('https://')===0)return d+u.search+u.hash
        }catch(e){}
        if(q.indexOf('http://')===0||q.indexOf('https://')===0)return q+u.search+u.hash;
        return q+u.search+u.hash
      }
      if(S&&u.pathname==='/f'&&window.$folio){
        return window.$folio.routeDestination(u.href)||u.href
      }
      return u.href
    }catch(e){return h}
  };
  window._W={D:D,P:P,S:S};
})();
</script>
`;

const SPA_PATCH = `
<script>
(function(){
  function ro(e){try{var m=e&&e.message!=null?String(e.message):'';return m.indexOf('ResizeObserver')!==-1}catch(x){}return false}
  function rj(e){try{var r=e&&e.reason,m=r&&(typeof r.message==='string'?r.message:(r&&r.toString&&r.toString())||'')||'';return String(m).indexOf('ResizeObserver')!==-1}catch(x){}return false}
  window.addEventListener('error',function(e){if(ro(e)){e.preventDefault();e.stopImmediatePropagation()}},true);
  window.addEventListener('unhandledrejection',function(e){if(rj(e))e.preventDefault()});
  var h=location.hostname||'';
  if(h.indexOf('discord.com')!==-1||h.indexOf('discordapp.com')!==-1){
    try{window.__SENTRY__={hub:{getClient:function(){return{getOptions:function(){return{}}}}}}}catch(x){}
    try{localStorage.setItem('hideMessageRequests','true')}catch(e){}
  }
})();
</script>
`;

const TURN_SCRIPT = `
<script>
(function(){
  var O=window.RTCPeerConnection;
  if(!O)return;
  function tc(){try{return window.top&&window.top.__LYRA_WEBRTC_TURN__}catch(e){}try{return window.parent&&window.parent.__LYRA_WEBRTC_TURN__}catch(e){}return window.__LYRA_WEBRTC_TURN__||null}
  function ds(){return[{urls:['turn:'+self.location.hostname+':3478?transport=udp','turn:'+self.location.hostname+':3478?transport=tcp'],username:'lyly',credential:'rara'}]}
  function to(sv){if(!Array.isArray(sv))return[];return sv.filter(function(s){
      if(!s||!s.urls)return false;
      var u=Array.isArray(s.urls)?s.urls:[s.urls];
      return u.some(function(u){u=String(u).toLowerCase();return u.indexOf('turn:')===0||u.indexOf('turns:')===0})
    }).map(function(s){var c={};for(var k in s)c[k]=s[k];var u=Array.isArray(s.urls)?s.urls:[s.urls];u=u.filter(function(u){u=String(u).toLowerCase();return u.indexOf('turn:')===0||u.indexOf('turns:')===0});c.urls=Array.isArray(s.urls)?u:u[0];return c})}
  function sc(cfg){
    var t=tc();cfg=cfg?Object.assign({},cfg):{};
    if(t&&t.enabled===false)return cfg;
    cfg.iceTransportPolicy='relay';
    var req=to(t&&t.iceServers).length?to(t.iceServers):ds();
    cfg.iceServers=to(cfg.iceServers).concat(req);
    return cfg
  }
  function W(cfg,cs){
    return cs!==undefined?new O(sc(cfg),cs):new O(sc(cfg))
  }
  W.prototype=O.prototype;
  try{Object.setPrototypeOf(W,O)}catch(e){}
  try{Object.defineProperty(W,'name',{value:'RTCPeerConnection'})}catch(e){}
  window.RTCPeerConnection=W;
})()
</script>
`;

const TURN_SCRIPT_RELAY = `
<script>
(function(){
  var O=window.RTCPeerConnection;
  if(!O)return;
  function tc(){try{return window.top&&window.top.__LYRA_WEBRTC_TURN__}catch(e){}try{return window.parent&&window.parent.__LYRA_WEBRTC_TURN__}catch(e){}return window.__LYRA_WEBRTC_TURN__||null}
  function ds(){return[{urls:['turn:'+self.location.hostname+':3478?transport=udp','turn:'+self.location.hostname+':3478?transport=tcp'],username:'lyly',credential:'rara'}]}
  function to(sv){if(!Array.isArray(sv))return[];return sv.filter(function(s){
      if(!s||!s.urls)return false;
      var u=Array.isArray(s.urls)?s.urls:[s.urls];
      return u.some(function(u){u=String(u).toLowerCase();return u.indexOf('turn:')===0||u.indexOf('turns:')===0})
    }).map(function(s){var c={};for(var k in s)c[k]=s[k];var u=Array.isArray(s.urls)?s.urls:[s.urls];u=u.filter(function(u){u=String(u).toLowerCase();return u.indexOf('turn:')===0||u.indexOf('turns:')===0});c.urls=Array.isArray(s.urls)?u:u[0];return c})}
  function relay(cand){try{if(!cand)return true;var s=typeof cand==='string'?cand:cand.candidate||'';return !s||/(^|\s)typ\s+relay(\s|$)/i.test(s)}catch(e){return true}}
  function sc(cfg){
    var t=tc();cfg=cfg?Object.assign({},cfg):{};
    if(t&&t.enabled===false)return cfg;
    cfg.iceTransportPolicy='relay';
    var req=to(t&&t.iceServers).length?to(t.iceServers):ds();
    cfg.iceServers=to(cfg.iceServers).concat(req);
    return cfg
  }
  function W(cfg,cs){
    var pc=cs!==undefined?new O(sc(cfg),cs):new O(sc(cfg));
    try{var add=pc.addEventListener.bind(pc);pc.addEventListener=function(type,fn,opt){if(type==='icecandidate'&&typeof fn==='function'){var f=function(e){if(relay(e&&e.candidate))return fn.call(this,e)};fn.__lyraRelay=f;return add(type,f,opt)}return add(type,fn,opt)}}catch(e){}
    try{var rem=pc.removeEventListener.bind(pc);pc.removeEventListener=function(type,fn,opt){return rem(type,fn&&fn.__lyraRelay||fn,opt)}}catch(e){}
    return pc
  }
  W.prototype=O.prototype;
  try{Object.setPrototypeOf(W,O)}catch(e){}
  try{Object.defineProperty(W,'name',{value:'RTCPeerConnection'})}catch(e){}
  window.RTCPeerConnection=W
})()
</script>
`;

const HOVER_PREFETCH_SCRIPT = `
<script>
(function(){
  var D=window._W.D,S=window._W.S;
  if(!('serviceWorker'in navigator))return;
  var max=40,sent=Object.create(null),cnt=0,sw=null;
  function kH(h){try{return String(h||'').split('#')[0]}catch(e){return''}}
  function pU(abs){
    try{
      var u=new URL(abs,location.href);
      if(u.origin===location.origin&&u.pathname==='/f'&&u.searchParams.has('s'))return kH(u.href);
      return null
    }catch(e){return null}
  }
  function aE(ev){var t=ev.target;if(t&&t.closest){var a=t.closest('a[href]');if(a)return a}var p=ev.composedPath&&ev.composedPath();if(p)for(var i=0;i<p.length;i++){var n=p[i];if(!n||n.nodeType!==1)continue;if(n.tagName==='A'&&n.getAttribute('href'))return n}return null}
  function pS(w,u){if(!w||typeof w.postMessage!=='function')return false;try{w.postMessage({type:'lyra-prefetch',url:u});return true}catch(e){return false}}
  async function pf(url){
    if(!url||sent[url])return;
    if(cnt>=max)return;
    var c=null;
    try{c=navigator.serviceWorker.controller}catch(e){}
    if(!c)c=sw;
    if(!c){try{var reg=await navigator.serviceWorker.ready;c=reg.active||reg.waiting||reg.installing||navigator.serviceWorker.controller;if(c)sw=c}catch(e){}}else sw=c;
    if(c&&pS(c,url)){sent[url]=1;cnt++;return}
    try{if(window.top&&window.top!==window){window.top.postMessage({type:'lyra-prefetch-bridge',url:url},location.origin);sent[url]=1;cnt++;return}}catch(e){}
  }
  function qP(ev){
    var el=aE(ev);if(!el)return null;
    var raw=el.getAttribute('href');if(!raw||raw.indexOf('javascript:')===0||raw==='#')return null;
    var abs;try{abs=new URL(raw,location.href).href}catch(e){return null}
    return pU(abs)
  }
  document.addEventListener('pointerdown',function(ev){var p=qP(ev);if(!p)return;pf(p)},true)
})();
</script>
`;

const META_SCRIPT = `
<script>
(function(){
  var D=window._W.D,S=window._W.S;
  var isTop;try{isTop=window.top===window||!!(window.frameElement&&window.frameElement.dataset.tabId)}catch(e){isTop=false}
  var mE=function(s){if(!s)return'';var k='wb!';try{var e=encodeURIComponent(s),r='';for(var i=0;i<e.length;i++)r+=String.fromCharCode(e.charCodeAt(i)^k.charCodeAt(i%k.length));return btoa(r)}catch(e){return s}};
  var tabId;try{if(window.name&&!isNaN(parseInt(window.name,10)))tabId=window.name;else tabId=window.frameElement&&window.frameElement.dataset?window.frameElement.dataset.tabId||null:null}catch(e){tabId=null}
  var sw=null,lU=null,lT=null,lF=null;
  function pT(){
    try{
      var s=[function(){return(document.title||'').trim()},function(){var og=document.querySelector('meta[property="og:title"], meta[name="og:title"]');return og&&og.content?og.content.trim():''},function(){var tw=document.querySelector('meta[property="twitter:title"], meta[name="twitter:title"]');return tw&&tw.content?tw.content.trim():''},function(){var mt=document.querySelector('meta[name="title"], meta[property="title"]');return mt&&mt.content?mt.content.trim():''},function(){var h=document.querySelector('h1,h2,h3');return h&&h.textContent?h.textContent.trim():''}];
      for(var i=0;i<s.length;i++){var v=s[i]();if(v)return v}
      return''
    }catch(e){return''}
  }
  function pI(){
    try{var ls=document.querySelectorAll('link[rel~="icon"], link[rel*="icon"]');for(var i=0;i<ls.length;i++){var h=ls[i].getAttribute('href');if(!h)continue;try{return new URL(h,location.href).href}catch(e){}}try{return new URL('/assets/images/icons/favicon.svg',location.href).href}catch(e){}return null}catch(e){return null}
  }
  async function sM(){
    if(!isTop&&!tabId)return;
    if(!('serviceWorker'in navigator))return;
    try{
      var c=navigator.serviceWorker.controller;
      if(!c)c=sw;
      if(!c){var reg=await navigator.serviceWorker.ready;c=reg.active||reg.waiting||reg.installing||navigator.serviceWorker.controller;if(c)sw=c}else sw=c;
      if(!c)return;
      var url=location.href,title=pT(),rf=pI(),df=rf?D(rf):null;
      if(lU===url&&lT===title&&lF===rf)return;
      lU=url;lT=title;lF=rf;
      c.postMessage({type:'page-meta',url:mE(url),decodedUrl:mE(D(url)),title:mE(title),favicon:mE(df||rf||null),rawFavicon:mE(rf||null),tabId:tabId,isTopFrame:isTop,encoded:true})
    }catch(e){}
  }
  var rM=function(){sM()};
  var dS=false;
  var rAF=typeof requestAnimationFrame==='function'?requestAnimationFrame:function(cb){setTimeout(cb,16)};
  var mD=function(){if(dS)return;dS=true;rAF(function(){dS=false;rM()})};
  var mic=typeof queueMicrotask==='function'?function(fn){queueMicrotask(fn)}:function(fn){Promise.resolve().then(fn)};
  var mN=function(){mic(function(){rM()});rAF(function(){rM();rAF(function(){rM()})})};
  function hH(){try{var push=history.pushState;history.pushState=function(){var r=push.apply(this,arguments);mN();return r};var replace=history.replaceState;history.replaceState=function(){var r=replace.apply(this,arguments);mN();return r}}catch(e){}}
  function bT(el){try{if(!el||el._wo)return;el._wo=true;var o=new MutationObserver(function(){mD()});o.observe(el,{childList:true,subtree:true,characterData:true})}catch(e){}}
  function hHt(muts){try{for(var i=0;i<muts.length;i++){var m=muts[i],t=m.target;if(!t)continue;if(m.type==='characterData'){var p=t.parentElement;if(p&&p.nodeName&&p.nodeName.toUpperCase()==='TITLE')return true;continue}if(m.type==='attributes'){var n=t.nodeName&&t.nodeName.toUpperCase();if(n==='META'||n==='LINK'||n==='TITLE')return true;continue}if(m.type==='childList'){var tn=t.nodeName&&t.nodeName.toUpperCase();if(tn==='TITLE'||tn==='META'||tn==='LINK')return true;if(tn==='HEAD'){var na=m.addedNodes;for(var j=0;j<na.length;j++){var nn=na[j]&&na[j].nodeName&&na[j].nodeName.toUpperCase();if(nn==='TITLE'||nn==='META'||nn==='LINK')return true}var nr=m.removedNodes;for(var k=0;k<nr.length;k++){var rn=nr[k]&&nr[k].nodeName&&nr[k].nodeName.toUpperCase();if(rn==='TITLE'||rn==='META'||rn==='LINK')return true}}}}return false}catch(e){}return false}
  function wH(){try{bT(document.querySelector('title'));var h=document.head||document.documentElement;if(!h||h._who)return;h._who=true;var o=new MutationObserver(function(muts){if(!hHt(muts))return;mD();bT(document.querySelector('title'))});o.observe(h,{childList:true,subtree:true,attributes:true,attributeFilter:['content','property','name','href','rel']})}catch(e){}}
  function start(){if(!S)hH();try{if('serviceWorker'in navigator)navigator.serviceWorker.addEventListener('controllerchange',function(){sw=navigator.serviceWorker.controller})}catch(e){}wH();mN()}
  self.addEventListener('popstate',mN);
  self.addEventListener('hashchange',mN);
  self.addEventListener('load',mN);
  start();
  var bc=0,bi=setInterval(function(){mN();bc++;if(bc>16)clearInterval(bi)},72);
  setInterval(function(){if(document.visibilityState!=='visible')return;mD()},450);
  function hOk(c){if(!c)return false;try{var p=new URL(c,location.href);return p.protocol==='http:'||p.protocol==='https:'}catch(e){return false}}
  function oT(raw,cause,active){
    if(!raw)return false;
    var abs;try{abs=new URL(raw,location.href).href}catch(e){abs=raw}
    if(abs.indexOf(self.location.origin)===0&&abs.indexOf(window._W.P)===-1&&new URL(abs).pathname!=='/f'){try{var bR=D(location.href)||location.href;abs=new URL(raw,bR).href}catch(e){}}
    var dec=D(abs)||abs;
    if(!hOk(dec))return false;
    var pl={type:'open-new-tab',url:abs,decodedUrl:dec,openerUrl:D(location.href)||location.href,tabId:tabId,isTopFrame:isTop,cause:cause||null,active:active!==false};
    var posted=false;
    var sp=function(c){if(c&&typeof c.postMessage==='function')try{c.postMessage(pl);posted=true}catch(e){}};
    try{if(window.top&&window.top!==window&&typeof window.top.postMessage==='function'){window.top.postMessage(pl,'*');posted=true}}catch(e){}
    if(!posted){try{if(navigator.serviceWorker){if(navigator.serviceWorker.controller){sp(navigator.serviceWorker.controller)}else if(navigator.serviceWorker.ready){navigator.serviceWorker.ready.then(function(reg){sp(reg.active||navigator.serviceWorker.controller)}).catch(function(){})}}}catch(e){}}
    return posted
  }
  function hO(){try{var orig=window.open;window.open=function(url,target){var res=url&&url.href?url.href:url;var t=(target||'').toLowerCase();var si=!target||t===''||t==='_blank'||t==='blank'||t==='_new'||!(t==='_self'||t==='_top'||t==='_parent');if(si&&typeof res==='string'){var p=oT(res,'window.open');if(p)return null;return null}return orig.apply(this,arguments)};window.open._wi=true;try{var wp=Window.prototype;if(wp&&typeof Object.getOwnPropertyDescriptor==='function'){var d=Object.getOwnPropertyDescriptor(wp,'open');if(d&&d.configurable)Object.defineProperty(wp,'open',{value:window.open,writable:true,configurable:true})}}catch(e){}}catch(e){}}
  function pF(e,pred){try{var path=e.composedPath?e.composedPath():[];for(var i=0;i<path.length;i++){if(pred(path[i]))return path[i]}var cur=e.target;while(cur){if(pred(cur))return cur;cur=cur.parentElement}}catch(e){}return null}
  function hC(){var h=function(e){try{var a=pF(e,function(n){return n&&n.href&&(n.tagName==='A'||n.tagName==='AREA')});if(!a)return;var href=a.href||a.getAttribute('href');if(!href)return;var be=document.querySelector('base'),bt=be?(be.getAttribute('target')||'').toLowerCase():'',ibn=bt&&!(bt===''||bt==='_self'||bt==='_top'||bt==='_parent');var ta=a.getAttribute('target'),tgt=(ta||'').toLowerCase(),het=a.hasAttribute('target'),int=het&&!(tgt===''||tgt==='_self'||tgt==='_top'||tgt==='_parent');var mr=e.ctrlKey||e.metaKey||e.button===1,si=int||ibn||mr;if(!si)return;var cause=int?'anchor-target-blank':(ibn?'anchor-base-target':'anchor-modifier');var p=oT(href,cause,mr?e.shiftKey:true);if(p){e.preventDefault();e.stopImmediatePropagation()}}catch(e){}};document.addEventListener('click',h,true);document.addEventListener('auxclick',h,true)}
  function gtF(f,s,be){var t='';if(s){var ft=(s.getAttribute('formtarget')||'').toLowerCase();if(ft)t=ft}if(!t){t=(f.getAttribute('target')||'').toLowerCase()}if(!t&&be){var bt=be.getAttribute('target');if(bt){bt=bt.toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}}return t}
  function gaF(f,s){if(s){var fa=s.getAttribute('formaction');if(fa)return fa}return f.getAttribute('action')||location.href}
  function hF(){var h=function(e){try{var f=pF(e,function(n){return n&&n.tagName==='FORM'});if(!f)return;var s=e.submitter||null;var be=document.querySelector('base');var t=gtF(f,s,be);if(!t||t==='_self'||t==='_top'||t==='_parent')return;var a=gaF(f,s),p=oT(a,'form-target-blank');if(p){e.preventDefault();e.stopImmediatePropagation()}}catch(e){}};document.addEventListener('submit',h,true)}
  function hFS(){try{var origSubmit=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){try{var f=this;var be=document.querySelector('base');var t=gtF(f,null,be);if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){var a=gaF(f,null);if(oT(a,'form-submit-blank'))return}}catch(e){}return origSubmit.call(this)}}catch(e){}}
  function hAC(){try{var pc=function(proto){var orig=proto.click;proto.click=function(){try{var href=this.href||this.getAttribute('href');if(!href)return orig.call(this);var t=(this.getAttribute('target')||'').toLowerCase();if(!t){var be=document.querySelector('base');if(be){var bt=(be.getAttribute('target')||'').toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}}if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){if(oT(href,'anchor-click-blank'))return}}catch(e){}return orig.call(this)}};pc(HTMLAnchorElement.prototype);pc(HTMLAreaElement.prototype)}catch(e){}}
  function hRS(){try{var proto=HTMLFormElement.prototype;if(!proto.requestSubmit)return;var orig=proto.requestSubmit;proto.requestSubmit=function(submitter){try{var t=(this.getAttribute('target')||'').toLowerCase();var a=this.getAttribute('action');if(submitter){var ft=(submitter.getAttribute('formtarget')||'').toLowerCase();if(ft)t=ft;var fa=submitter.getAttribute('formaction');if(fa)a=fa}if(!a)a=location.href;if(!t){var be=document.querySelector('base');if(be){var bt=(be.getAttribute('target')||'').toLowerCase();if(bt&&bt!=='_self'&&bt!=='_top'&&bt!=='_parent')t=bt}}if(t&&t!=='_self'&&t!=='_top'&&t!=='_parent'){if(oT(a,'form-requestsubmit-blank'))return}}catch(e){}if(submitter!==undefined)return orig.call(this,submitter);return orig.call(this)}}catch(e){}}
  function hIF(){try{var pw=function(w){try{if(w&&!w.open._wi){w.open=window.open;w.open._wi=true}}catch(e){}};var pp=function(proto,prop){try{var d=Object.getOwnPropertyDescriptor(proto,prop);if(d&&d.configurable&&d.get){var o=d.get;Object.defineProperty(proto,prop,{get:function(){var w=o.call(this);try{pw(w)}catch(e){}return w},configurable:true,enumerable:true})}}catch(e){}};pp(HTMLIFrameElement.prototype,'contentWindow');pp(HTMLFrameElement.prototype,'contentWindow');pp(HTMLObjectElement.prototype,'contentWindow')}catch(e){}}
  hO();hC();hF();hFS();hAC();hRS();hIF()
})();
</script>
`;

const INJECT_PATCHES_STANDARD =
  SHARED_SCRIPT + TURN_SCRIPT + SPA_PATCH + HOVER_PREFETCH_SCRIPT + META_SCRIPT;
const INJECT_PATCHES_RELAY =
  SHARED_SCRIPT + TURN_SCRIPT_RELAY + SPA_PATCH + HOVER_PREFETCH_SCRIPT + META_SCRIPT;

function buildHtmlInjectPatches(upstreamUrlStr) {
  const host = upstreamHostname(upstreamUrlStr || "");
  if (!host) return INJECT_PATCHES_STANDARD;
  const cached = _injectPatchCache.get(host);
  if (cached) return cached;
  const result = isDiscordRelayOnlyHost(host)
    ? INJECT_PATCHES_RELAY
    : INJECT_PATCHES_STANDARD;
  if (_injectPatchCache.size > 64) {
    const oldest = _injectPatchCache.keys().next().value;
    _injectPatchCache.delete(oldest);
  }
  _injectPatchCache.set(host, result);
  return result;
}

const HEAD_START_RE = /<head\b[^>]*>/i;

async function patchHtml(response, upstreamUrlStr) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || !response.body) return response;
  try {
    const lenHdr = response.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_HTML_INJECT_BYTES) return response;
    const clonedResponse = response.clone();
    const originalBody = await clonedResponse.text();
    if (originalBody.length > MAX_HTML_INJECT_BYTES) return response;
    const scripts = buildHtmlInjectPatches(upstreamUrlStr);
    let newBodyStr;
    const headMatch = HEAD_START_RE.exec(originalBody);
    if (headMatch) {
      const headEndIdx = headMatch.index + headMatch[0].length;
      newBodyStr =
        originalBody.substring(0, headEndIdx) +
        scripts +
        originalBody.substring(headEndIdx);
    } else {
      newBodyStr = scripts + originalBody;
    }
    return new Response(newBodyStr, {
      status: response.status,
      statusText: response.statusText,
      headers: fixHtmlHeaders(response.headers),
    });
  } catch (e) {
    return response;
  }
}
