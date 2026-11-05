/**
 * Small modules shaped like the Discord code the ui subpath patches, as Discord shipped it on
 * 2026-11-05, and the parts of Evi's source patcher that the tests need: `\i`, string finds, and
 * String.prototype.replace on the code so far.
 */
import type { SourcePatch } from "@evi/api";

export const chatBarModule = String.raw`function(e,t,n){let i=n.jsx,P="ChannelTextAreaButtons",b="app-launcher",ed="send";t.A=function(e){let{channel:S,disabled:g}=e,$=[],N=()=>{},j=!1,ee=!0,q=!0,F=!0;return(q&&F&&$.push((0,i.jsx)(b,{channelId:S.id},"appLauncher")),ee&&$.push((0,i.jsx)(ed,{onClick:N,disabled:g||j},"submit")),0===$.length)?null:(0,i.jsx)("div",{className:"buttons",children:$})}}`;

export const popoverModule = String.raw`function(e,t,n){let a=n.jsx,ni={qv:n.Button},t_={DT:()=>{},cL:()=>{}};t.A=function(e){let{channel:t,message:n,canCopy:l}=e,N=!0,x=!0,h=!1;return(0,a.jsxs)("div",{className:"hover-bar",children:[x?(0,a.jsxs)(a.Fragment,{children:[l&&N?(0,a.jsx)(ni.qv,{label:"Copy ID",icon:"i",onClick:e=>(0,t_.DT)(t,n,e)},"copy-id"):null,l?(0,a.jsx)(ni.qv,{label:"Copy Link",icon:"i",onClick:e=>(0,t_.cL)(t,n,e)},"copy-link"):null]}):null,h?"reactions":null,(0,a.jsx)(ni.qv,{label:"More",icon:"i",onClick:()=>{}},"more")]})}}`;

export const accessoriesModule = String.raw`function(e,t,n){let s=n.jsx;t.Ay=class extends n.React.Component{renderSuppressConfirmModal(){return null}renderRemoveAttachmentConfirmModal(){return null}render(){let{message:t}=this.props,l=!1,r=!1,a=(0,s.jsx)("span",{children:"(edited)"},"edited");return(0,s.jsxs)("div",{className:"accessories",children:[a,l&&this.renderSuppressConfirmModal(),r&&this.renderRemoveAttachmentConfirmModal(),null]})}}}`;

export const sendModule = String.raw`function(e,t,n){let tD={S:(t,o)=>n.slash?.(t)},P=".handleSendMessage,onResize:";t.send=function(t,h,validate){return validate({content:t,channel:h}).then(e=>{let{valid:s,failureReason:A}=e;if(!s)if(A==="slowmode")return{shouldClear:!1,shouldRefocus:!0};else return{shouldClear:!1,shouldRefocus:!1};let f=(0,tD.S)(t,{channel:h,isEdit:!1});null!=f&&(t=f);n.sent(h.id,t);return{shouldClear:!0,shouldRefocus:!0}})}}`;

export const editModule = String.raw`function(e,t,r){let l={S:(e,o)=>null};t.edit=function(e,n,t,u){return u({value:e,channel:n,message:t}).then(s=>{let{valid:u}=s;if(!u)return Promise.resolve({shouldClear:!1,shouldRefocus:!1});let d=(0,l.S)(e,{channel:n,isEdit:!0});e!==t.content&&r.saved(n.id,t.id,e);return Promise.resolve({shouldClear:!0,shouldRefocus:!0})})}}`;

const IDENT = String.raw`(?:[A-Za-z_$][\w$]*)`;
const canonical = (match: string | RegExp) => typeof match === "string" ? match : new RegExp(match.source.replace(/(?<!\\)\\i/g, IDENT), match.flags);

/** Applies `patches` to `code` as Evi does, throwing where Evi would call a patch broken */
export function patch(code: string, patches: SourcePatch[]): string {
    for (const p of patches) {
        if (typeof p.find !== "string" || !code.includes(p.find)) throw new Error(`find ${String(p.find)} isn't in the module`);
        for (const r of [p.replace].flat()) {
            const next = code.replace(canonical(r.match) as RegExp, r.with as (substring: string, ...args: unknown[]) => string);
            if (next === code) throw new Error(`replacement ${String(r.match)} matched nothing`);
            code = next;
        }
    }
    return code;
}

/** Runs a module's code as webpack would, with `deps` as its require, and returns its exports */
export function load(code: string, deps: Record<string, unknown>): Record<string, any> {
    const exports: Record<string, any> = {};
    const factory = new Function(`return (${code});`)();
    factory({ exports }, exports, deps);
    return exports;
}
