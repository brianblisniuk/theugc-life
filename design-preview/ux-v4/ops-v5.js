(function client(){
"use strict";
const A=()=>window.UXApp, E=id=>document.getElementById(id), esc=x=>A().esc(x==null?"":String(x)), ic=n=>A().ic(n);
const read=(key,fallback)=>{try{let s=localStorage.getItem(key);return s?JSON.parse(s):fallback}catch(_){return fallback}},write=(key,v)=>{try{localStorage.setItem(key,JSON.stringify(v))}catch(_){}};
const G=(k,def)=>read("ugc_v4_"+k,def),W=(k,v)=>write("ugc_v4_"+k,v),hotel=id=>A().H.find(h=>h.id===id),uid=s=>s+"-"+Date.now()+"-"+Math.floor(Math.random()*100000);
const nowDays=d=>new Date(Date.now()-86400000*d).toISOString(),when=iso=>iso?new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric"}):"—";
let data={},ui={campaign:null,search:"",stage:"all",view:"board",drawer:null,closed:false};
const steps=[["saved","Saved"],["draft","Pitch ready"],["sent","Outreach sent"],["replied","In conversation"],["won","Confirmed"]];
function refresh(){data.campaigns=G("campaigns",[]);data.events=G("events",[]);data.drafts=G("drafts",[]);data.contracts=G("contracts",[]);data.notes=read("ugc_v5_notes",[])}
function persist(){["campaigns","events","drafts","contracts"].forEach(k=>W(k,data[k]));write("ugc_v5_notes",data.notes)}
function bootstrap(){
if(read("ugc_v5_demo_seeded",false))return;
if(data.campaigns.length||data.events.length||data.drafts.length||A().state.pipeline.length)return;
const trip=A().state.trips.find(t=>t.city==="Bangkok");
data.campaigns=[
{id:"demo-bangkok",name:"Bangkok · November outreach",tripId:trip?.id||"",city:"Bangkok",hotelIds:["canopy","riverline","atelier","garden","lumphini","lantern"],createdAt:nowDays(10),sample:true},
{id:"demo-bali",name:"Bali · January opportunities",tripId:"",city:"Bali",hotelIds:["island"],createdAt:nowDays(3),sample:true}
];
data.drafts=[
{id:"demo-draft-atelier",hotelId:"atelier",campaignId:"demo-bangkok",subject:"Content collaboration · Atelier",body:"Sample draft. This email was not sent.",updatedAt:nowDays(1),sample:true},
{id:"demo-draft-river",hotelId:"riverline",campaignId:"demo-bangkok",subject:"Social-first UGC proposal",body:"Sample draft. This email was not sent.",updatedAt:nowDays(8),sample:true}];
data.events=[
{id:"demo-1",hotelId:"riverline",campaignId:"demo-bangkok",type:"stage",value:"sent",at:nowDays(6),source:"sample"},
{id:"demo-2",hotelId:"canopy",campaignId:"demo-bangkok",type:"stage",value:"sent",at:nowDays(8),source:"sample"},
{id:"demo-3",hotelId:"canopy",campaignId:"demo-bangkok",type:"stage",value:"replied",at:nowDays(2),source:"sample"},
{id:"demo-4",hotelId:"lumphini",campaignId:"demo-bangkok",type:"stage",value:"sent",at:nowDays(7),source:"sample"},
{id:"demo-5",hotelId:"lumphini",campaignId:"demo-bangkok",type:"stage",value:"negotiating",at:nowDays(1),source:"sample"}
];
data.notes=[{id:"demo-note",hotelId:"lumphini",text:"Example: Review deliverables and usage rights before agreeing.",at:nowDays(1)}];
for(const id of ["canopy","riverline","atelier","garden","lumphini","lantern","island"]){if(!A().state.pipeline.includes(id))A().state.pipeline.push(id)}
A().saveState();persist();write("ugc_v5_demo_seeded",true);write("ugc_v5_demo_active",true);
}
function stage(id){
const ev=data.events.filter(e=>e.hotelId===id&&e.type==="stage").sort((x,y)=>x.at.localeCompare(y.at)).at(-1);
if(ev)return ev.value;
return data.drafts.some(d=>d.hotelId===id)?"draft":"saved";
}
function laneFor(id){const s=stage(id);return s==="negotiating"?"replied":s==="bounced"?"sent":s==="not-started"?"saved":s}
const title=s=>({saved:"Saved",draft:"Pitch drafted",sent:"Sent · manual",replied:"Replied · manual",negotiating:"Negotiating · manual",bounced:"Bounce reported",won:"Agreed · manual",closed:"Closed"}[s]||"Saved");
function pill(id){const s=stage(id),c=["replied","won"].includes(s)?"lime":["negotiating","bounced"].includes(s)?"amber":s==="sent"?"blue":"";return `<span class="ops-pill ${c}">${esc(title(s))}</span>`}
function initials(h){return h.name.split(" ").slice(0,2).map(x=>x[0]).join("").toUpperCase()}
function m(ids){const count=s=>ids.filter(id=>stage(id)===s).length;return {leads:ids.length,drafts:ids.filter(id=>data.drafts.some(d=>d.hotelId===id)).length,contacted:ids.filter(id=>["sent","replied","negotiating","won","bounced"].includes(stage(id))).length,conversations:ids.filter(id=>["replied","negotiating","won"].includes(stage(id))).length,count}}
function stats(ids){const x=m(ids);return [["Selected hotels",x.leads,"Shared hotel records"],["Drafts prepared",x.drafts,"Individualized pitches"],["Sent logged",x.contacted,"Manual / sample events"],["Conversations",x.conversations,"Reported by creator"]].map(([name,n,sub],i)=>`<div class="ops-stat ${i===3?"highlight":""}"><span class="k">${ic(["building","mail","arrow","check"][i])} ${name}</span><strong>${n}</strong><small>${sub}</small></div>`).join("")}
function savedIDs(){return [...new Set([...A().state.pipeline,...data.events.map(e=>e.hotelId),...data.drafts.map(e=>e.hotelId)])].filter(id=>hotel(id))}
function related(id){return data.campaigns.filter(c=>c.hotelIds.includes(id))}
function openHotel(id){location.href="hotel.html?id="+encodeURIComponent(id)}
function showCampaigns(){
if(document.body.dataset.page!=="campaigns")return;
refresh();
if(!data.campaigns.some(c=>c.id===ui.campaign))ui.campaign=data.campaigns[0]?.id||"";
E("ops-campaign-pills").innerHTML=data.campaigns.length?data.campaigns.map(c=>{const x=m(c.hotelIds.filter(id=>hotel(id))),sel=c.id===ui.campaign;return `<button class="ops-chooser-card ${sel?"active":""}" aria-pressed="${sel}" data-op-campaign="${esc(c.id)}"><div class="ops-chooser-title"><span class="ops-chooser-pin">${ic("pin")}</span>${c.sample?'<span class="ops-pill amber">Sample data</span>':`<span class="ops-pill">${sel?"Selected":"Open"}</span>`}</div><strong>${esc(c.name)}</strong><small>${esc(c.city)} · ${x.leads} hotels</small><div class="ops-track" style="height:5px;background:#DFE9DB;margin-top:15px"><div class="ops-fill" style="width:${x.leads?x.contacted/x.leads*100:0}%"></div></div></button>`}).join(""):`<div class="ops-emptybox"><h3>Start your first campaign</h3><p>Organize hotel outreach around a destination or Trip.</p><button class="btn lime" data-op="create">Create a campaign</button></div>`;
let c=data.campaigns.find(c=>c.id===ui.campaign);
E("ops-campaign-workspace").hidden=!c;E("ops-campaign-none").hidden=!!c;if(!c)return;
let ids=c.hotelIds.filter(id=>hotel(id)),x=m(ids),trip=A().tripById(c.tripId);
E("ops-campaign-city").textContent=c.city.toUpperCase()+" / "+(trip?trip.name:"INDEPENDENT CAMPAIGN");
E("ops-campaign-title").textContent=c.name;E("ops-campaign-desc").textContent=trip?"Linked to "+trip.name+" · Organized around your journey.":"A focused destination campaign with individual hotel pitches.";
E("ops-campaign-progress").style.width=(x.leads?x.contacted/x.leads*100:0)+"%";
E("ops-campaign-progress-title").textContent=x.contacted+" / "+x.leads;
E("ops-progress-percent").textContent=(x.leads?Math.round(x.contacted/x.leads*100):0)+"%";
E("ops-stat-grid").innerHTML=stats(ids);
E("ops-campaign-id").textContent=ids.length+" selected hotels"+(c.sample?" · Illustrative":"");
const recommendation=x.conversations?["Keep the conversation moving","Review replies and negotiations before pitching new hotels.","pipeline.html?filter=conversation","Open conversations"]:x.drafts?["Finish pitches already started","Review drafts, verify recipients and avoid sending generic emails.","pipeline.html?filter=draft","Review drafts"]:["Start with a strong proposal","Prepare a useful, personalized pitch for one hotel.","pitch.html?hotel="+encodeURIComponent(ids[0]||"canopy"),"Start pitching"];
E("ops-focus-card").innerHTML=`<div class="eyebrow">YOUR NEXT MOVE</div><h3>${recommendation[0]}</h3><p>${recommendation[1]}</p><a class="btn lime" href="${recommendation[2]}">${recommendation[3]} ${ic("arrow")}</a>`;
showLeads();
let events=data.events.filter(e=>c.hotelIds.includes(e.hotelId)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,5);
E("ops-campaign-events").innerHTML=events.length?events.map(e=>`<div class="ops-event"><strong>${esc(hotel(e.hotelId)?.name||"Hotel")}</strong><p>${esc(title(e.value))} · ${e.source==="sample"?"Illustrative":e.source==="manual"?"Manual":"Not verified"}</p><small>${when(e.at)}</small></div>`).join(""):'<div class="ops-no-data">No activity yet. Drafts and updates appear here.</div>';
}
function showLeads(){
const c=data.campaigns.find(c=>c.id===ui.campaign);if(!c)return;
let ids=c.hotelIds.filter(id=>hotel(id));
if(ui.search)ids=ids.filter(id=>hotel(id).name.toLowerCase().includes(ui.search.toLowerCase()));
if(ui.stage!=="all")ids=ids.filter(id=>laneFor(id)===ui.stage);
E("ops-lead-count").textContent=ids.length+" visible";
E("ops-campaign-rows").innerHTML=ids.length?ids.map(id=>{const h=hotel(id),d=data.drafts.find(d=>d.hotelId===id&&d.campaignId===c.id);
const s=stage(id),onward=["sent","replied","negotiating","won","bounced"].includes(s),href=onward?"pipeline.html?hotel="+encodeURIComponent(id):"pitch.html?hotel="+encodeURIComponent(id)+"&campaign="+encodeURIComponent(c.id);
return `<tr><td><div class="ops-lead-ident"><span class="ops-ident-mark">${esc(initials(h))}</span><div><strong>${esc(h.name)}</strong><small>${esc(h.city)} · ${esc(h.type)}</small></div></div></td><td>${pill(id)}</td><td><span class="ops-pill">${esc(h.activity)} activity</span></td><td><strong>${d?"Draft saved":"Not drafted"}</strong><small style="display:block;color:#758476;margin-top:6px">${A().state.unlocks.includes(id)?"Demo contact unlocked":"Contact locked"}</small></td><td><div class="ops-lead-right"><a class="btn small" href="${href}">${onward?"Open deal":"Prepare pitch"} ${ic("arrow")}</a><button class="btn small" data-op-hotel="${esc(id)}" title="Hotel details">${ic("building")}</button></div></td></tr>`;
}).join(""):`<tr><td colspan="5"><div class="ops-no-data"><strong>No matching hotels</strong><p>Adjust filters or add hotels to this campaign.</p></div></td></tr>`;
}
function newCampaign(){
const tripOptions=A().state.trips.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
const cities=[...new Set(A().H.map(h=>h.city))].map(city=>`<option>${esc(city)}</option>`).join("");
A().modal("New outreach campaign",`<p>Bring target hotels together before preparing individual pitches. Campaigns are not bulk-email tools.</p><form id="ops-new-form"><div class="field" style="margin-top:16px"><label for="ops-name">CAMPAIGN NAME</label><input id="ops-name" required maxlength="100" placeholder="e.g. Bali February outreach"></div><div class="modal-fields"><div class="field"><label for="ops-city">DESTINATION</label><select id="ops-city">${cities}</select></div><div class="field"><label for="ops-trip">RELATED TRIP</label><select id="ops-trip"><option value="">No trip</option>${tripOptions}</select></div></div><p class="fine">When linked, the campaign can use hotels already shortlisted in that Trip.</p><div class="modal-bottom"><button class="btn" type="button" data-close>Cancel</button><button class="btn lime" type="submit">Create campaign</button></div></form>`);
}
function addLeads(){
const c=data.campaigns.find(x=>x.id===ui.campaign);if(!c)return;
const saved=new Set([...A().state.pipeline,...Object.values(A().state.shortlists).flat()]);
const options=A().H.filter(h=>h.city===c.city&&!c.hotelIds.includes(h.id)).sort((x,y)=>Number(saved.has(y.id))-Number(saved.has(x.id)));
A().modal("Add hotels to "+esc(c.name),`<p>Select hotels from the same catalog used by Discover and My Trips.</p><form id="ops-add-form"><div style="max-height:320px;overflow:auto">${options.length?options.map(h=>`<label class="choice-card"><input name="hotel" type="checkbox" value="${esc(h.id)}"><span><strong>${esc(h.name)}</strong><small>${esc(h.city)} · ${esc(h.type)}${saved.has(h.id)?" · Saved":""}</small></span></label>`).join(""):'<p class="fine">All available hotels in this destination are in the campaign.</p>'}</div><div class="modal-bottom"><button type="button" class="btn" data-close>Cancel</button><button class="btn lime" type="submit">Add selected</button></div></form>`);
}
function focused(){
const ids=savedIDs();let r=[];
for(const id of ids.filter(id=>["replied","negotiating"].includes(stage(id))).slice(0,2))r.push({id,label:"Continue conversation",text:hotel(id).name+" · reply/negotiation logged",category:"CONVERSATION"});
for(const id of ids.filter(id=>stage(id)==="sent").slice(0,2))r.push({id,label:"Review follow-up",text:hotel(id).name+" · check your real inbox",category:"FOLLOW-UP CHECK"});
for(const id of ids.filter(id=>stage(id)==="draft").slice(0,2))r.push({id,label:"Review saved pitch",text:hotel(id).name+" · ready for editing",category:"PITCH READY"});
for(const id of ids.filter(id=>stage(id)==="saved").slice(0,2))r.push({id,label:"Prepare an opportunity",text:hotel(id).name+" · no pitch yet",category:"NEXT START"});
return r.slice(0,3);
}
function showPipeline(){
if(document.body.dataset.page!=="pipeline")return;refresh();
let ids=savedIDs().filter(id=>ui.closed||stage(id)!=="closed");
const x=m(ids);
E("ops-pipeline-count").textContent=ids.length;
E("ops-pipeline-summary").textContent=ids.length+" tracked hotels · "+x.conversations+" conversations";
E("ops-pipeline-stats").innerHTML=stats(ids);
E("ops-pipeline-hero-action").textContent=x.conversations?x.conversations+" conversations in motion":"Build your next opportunity";
E("ops-priority-cards").innerHTML=focused().length?focused().map((r,i)=>`<button class="ops-task" data-op-deal="${esc(r.id)}"><span class="ops-pill ${i===0?"lime":""}">${esc(r.category)}</span><strong>${esc(r.label)}</strong><small>${esc(r.text)} ${ic("arrow")}</small></button>`).join(""):'<div class="ops-emptybox"><h3>All clear for now</h3><p>Explore hotels and start a conversation.</p></div>';
if(ui.search)ids=ids.filter(id=>hotel(id).name.toLowerCase().includes(ui.search.toLowerCase())||hotel(id).city.toLowerCase().includes(ui.search.toLowerCase()));
if(ui.stage!=="all")ids=ids.filter(id=>ui.stage==="conversation"?["replied","negotiating"].includes(stage(id)):laneFor(id)===ui.stage);
for(const v of ["board","list","timeline"])E("ops-deal-"+v).hidden=ui.view!==v;
document.querySelectorAll("[data-op-view]").forEach(x=>{x.classList.toggle("active",x.dataset.opView===ui.view);x.setAttribute("aria-pressed",String(x.dataset.opView===ui.view))});
if(ui.view==="board")showBoard(ids);if(ui.view==="list")showList(ids);if(ui.view==="timeline")showTimeline(ids);
}
function dealCard(id){
const h=hotel(id),campaign=data.campaigns.find(c=>c.hotelIds.includes(id));
return `<article class="ops-deal" data-op-deal="${esc(id)}" draggable="true" role="button" tabindex="0" aria-label="Open ${esc(h.name)}"><div class="ops-deal-top"><span class="ops-initial">${esc(initials(h))}</span>${pill(id)}</div><h3>${esc(h.name)}</h3><p>${esc(h.city)} · ${esc(campaign?.name||"Independent")}</p><div class="ops-deal-foot"><span>${data.drafts.some(d=>d.hotelId===id)?"Pitch saved":"No pitch yet"}</span><button class="action" data-op-deal="${esc(id)}">Open ${ic("arrow")}</button></div></article>`;
}
function showBoard(ids){
E("ops-deal-board").innerHTML=steps.map(([id,name])=>`<section class="ops-lane" data-stage="${id}"><div class="ops-lane-head"><strong><span class="ops-dot ${id==="sent"?"blue":id==="draft"?"amber":"gray"}"></span> ${name}</strong><small>${ids.filter(x=>laneFor(x)===id).length}</small></div><div class="ops-lane-stack">${ids.filter(x=>laneFor(x)===id).map(dealCard).join("")}</div></section>`).join("");
}
function showList(ids){E("ops-deal-list").innerHTML=ids.length?ids.map(id=>{const h=hotel(id),c=data.campaigns.find(c=>c.hotelIds.includes(id));return `<div class="ops-list-item"><div><strong>${esc(h.name)}</strong><br><small>${esc(h.city)}</small></div><div>${pill(id)}</div><div><small>${esc(c?.name||"No campaign")}</small></div><div><small>${data.drafts.some(d=>d.hotelId===id)?"Pitch saved":"No draft"}</small></div><button class="btn small" data-op-deal="${esc(id)}">Details ${ic("arrow")}</button></div>`}).join(""):'<div class="ops-no-data">No deals match this view.</div>'}
function showTimeline(ids){
const events=data.events.filter(e=>ids.includes(e.hotelId)).sort((a,b)=>b.at.localeCompare(a.at));
E("ops-deal-timeline").innerHTML=events.length?events.map(e=>`<div class="ops-event"><strong>${esc(hotel(e.hotelId)?.name||"Hotel")} · ${esc(title(e.value))}</strong><p>${e.source==="sample"?"Illustrative scenario":"Manually logged · unverified event"}</p><small>${when(e.at)} <button class="ops-quietlink" data-op-deal="${esc(e.hotelId)}">View relationship →</button></small></div>`).join(""):'<div class="ops-no-data">No activity recorded in this view.</div>';
}
function dealHistory(id){
const events=data.events.filter(e=>e.hotelId===id).map(e=>({type:"event",text:title(e.value),at:e.at,source:e.source}));
const notes=data.notes.filter(n=>n.hotelId===id).map(n=>({type:"note",text:n.text,at:n.at,source:"manual"}));
return [...events,...notes].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,12).map(e=>`<div class="ops-event"><strong>${e.type==="note"?"Your note":esc(e.text)}</strong><p>${e.type==="note"?esc(e.text):e.source==="sample"?"Illustrative event":"Manual · not Gmail verified"}</p><small>${when(e.at)}</small></div>`).join("")||'<p class="ops-micro">No activity logged yet.</p>';
}
function drawerOpen(id){
if(!hotel(id))return;ui.drawer=id;E("ops-drawer").classList.add("open");E("ops-drawer-shade").classList.add("visible");document.body.style.overflow="hidden";drawerRender();E("ops-drawer-close").focus();
}
function drawerRender(){
const id=ui.drawer,h=hotel(id),c=data.campaigns.find(c=>c.hotelIds.includes(id));
E("ops-drawer-content").innerHTML=`<div class="eyebrow">RELATIONSHIP COCKPIT</div><h2>${esc(h.name)}</h2><p class="ops-micro">${esc(h.city)} · ${esc(h.type)} · ${esc(h.activity)} sample activity</p>
<div class="ops-drawer-info"><div class="side-row"><span>Stage</span><b>${esc(title(stage(id)))}</b></div><div class="side-row"><span>Campaign</span><b>${esc(c?.name||"Independent")}</b></div><div class="side-row"><span>Contact</span><b>${A().state.unlocks.includes(id)?"Unlocked in demo":"Locked"}</b></div><div class="side-row"><span>Draft</span><b>${data.drafts.some(d=>d.hotelId===id)?"Available":"Not started"}</b></div><div class="side-row"><span>Contract reviews</span><b>${data.contracts.filter(c=>c.hotelId===id).length}</b></div></div>
<div class="field"><label for="ops-drawer-stage">UPDATE STAGE MANUALLY</label><select id="ops-drawer-stage">${[["saved","Saved"],["draft","Pitch drafted"],["sent","Outreach sent"],["replied","Hotel replied"],["negotiating","Negotiating"],["won","Agreement reached"],["bounced","Bounce reported"],["closed","Closed"]].map(([v,t])=>`<option value="${v}" ${stage(id)===v?"selected":""}>${t}</option>`).join("")}</select><button class="btn lime wide" data-op="stage-update" style="margin-top:9px">Save manual stage</button><p class="ops-micro">Changes aren't verified email or collaboration events. They will never train Creator Intelligence.</p></div>
<div class="ops-divider"></div><h3>Continue this relationship</h3><div class="ops-drawer-actions"><a class="btn dark" href="pitch.html?hotel=${encodeURIComponent(id)}${c?"&campaign="+encodeURIComponent(c.id):""}">Open pitch studio</a><a class="btn" href="hotel.html?id=${encodeURIComponent(id)}">Hotel detail</a><a class="btn" href="contract-review.html?hotel=${encodeURIComponent(id)}">Contract review</a><a class="btn" href="inbox.html">Inbox</a></div>
<div class="ops-divider"></div><h3>Private notes</h3><p class="ops-micro">Keep context without creating a new data record for the same hotel.</p><textarea id="ops-note" placeholder="What matters for the next response?"></textarea><button class="btn small" data-op="note-add" style="margin-top:9px">Add note</button>
<div class="ops-divider"></div><h3>Activity</h3>${dealHistory(id)}`;
}
function drawerClose(){ui.drawer=null;E("ops-drawer").classList.remove("open");E("ops-drawer-shade").classList.remove("visible");document.body.style.overflow="";E("ops-pipeline-focus")?.focus()}
function stageChange(id,v){
if(stage(id)===v){A().toast("Already in that stage");return}
if(A().state.plan==="free"&&["draft","sent","replied","negotiating","won","bounced"].includes(v)){
const count=savedIDs().filter(x=>x!==id&&["draft","sent","replied","negotiating","won","bounced"].includes(stage(x))).length;
if(count>=5&&!["draft","sent","replied","negotiating","won","bounced"].includes(stage(id))){A().upgrade("Free allows up to five relationships past saved. Pro unlocks a larger working pipeline.");return}
}
if(["sent","replied","won","bounced"].includes(v)){A().modal("Confirm manual status",`<p>Record <b>${esc(hotel(id).name)}</b> as <b>${esc(v)}</b>? This is a manual statement, not a verified Gmail event or confirmed hotel agreement.</p><div class="modal-bottom"><button class="btn" data-close>Cancel</button><button class="btn lime" data-op-stage-confirm="${esc(id)}" data-stage="${esc(v)}">Confirm manual update</button></div>`)}
else applyStage(id,v);
}
function applyStage(id,v){data.events.push({id:uid("event"),hotelId:id,type:"stage",value:v,at:new Date().toISOString(),source:"manual"});if(!A().state.pipeline.includes(id))A().state.pipeline.push(id);persist();A().saveState();A().closeModal();A().toast("Stage saved locally · "+v);showPipeline();if(ui.drawer===id)drawerRender()}
function init(){
if(!["campaigns","pipeline"].includes(document.body.dataset.page))return;
refresh();bootstrap();refresh();let q=new URLSearchParams(location.search);
if(document.body.dataset.page==="campaigns"){ui.campaign=q.get("campaign")||data.campaigns[0]?.id||"";showCampaigns()}
else{ui.stage=q.get("filter")==="conversation"?"conversation":q.get("filter")||"all";showPipeline();let id=q.get("hotel");if(id)setTimeout(()=>drawerOpen(id),200)}
}
document.addEventListener("DOMContentLoaded",init);
document.addEventListener("click",e=>{
const b=e.target.closest("[data-op],[data-op-campaign],[data-op-deal],[data-op-view],[data-op-hotel],[data-op-stage-confirm]");if(!b)return;
if(b.dataset.opCampaign){ui.campaign=b.dataset.opCampaign;ui.search="";ui.stage="all";E("ops-lead-search").value="";E("ops-lead-stage").value="all";history.replaceState({},'',location.pathname+"?campaign="+encodeURIComponent(ui.campaign));showCampaigns();return}
if(b.dataset.opHotel){openHotel(b.dataset.opHotel);return}
if(b.dataset.opView){ui.view=b.dataset.opView;showPipeline();return}
if(b.dataset.opDeal){if(e.target.closest("a"))return;drawerOpen(b.dataset.opDeal);return}
if(b.dataset.opStageConfirm){applyStage(b.dataset.opStageConfirm,b.dataset.stage);return}
const op=b.dataset.op;
if(op==="create")newCampaign();
if(op==="add-leads")addLeads();
if(op==="stage-update")stageChange(ui.drawer,E("ops-drawer-stage").value);
if(op==="note-add"){const text=E("ops-note").value.trim();if(!text)return A().toast("Write a note first");data.notes.push({id:uid("note"),hotelId:ui.drawer,text,at:new Date().toISOString()});persist();drawerRender();A().toast("Note saved")}
if(op==="drawer-close")drawerClose();
if(op==="toggle-closed"){ui.closed=!ui.closed;b.setAttribute("aria-pressed",String(ui.closed));b.textContent=ui.closed?"Hide closed":"Include closed";showPipeline()}
});
document.addEventListener("change",e=>{
if(e.target.id==="ops-lead-stage"){ui.stage=e.target.value;showLeads()}
if(e.target.id==="ops-pipeline-stage"){ui.stage=e.target.value;showPipeline()}
if(e.target.id==="ops-trip"){const t=A().tripById(e.target.value);if(t)E("ops-city").value=t.city}
});
document.addEventListener("input",e=>{
if(e.target.id==="ops-lead-search"){ui.search=e.target.value;showLeads()}
if(e.target.id==="ops-pipeline-search"){ui.search=e.target.value;showPipeline()}
});
document.addEventListener("submit",e=>{
if(e.target.id==="ops-new-form"){e.preventDefault();const name=E("ops-name").value.trim(),tripId=E("ops-trip").value,t=A().tripById(tripId),city=t?t.city:E("ops-city").value;if(!name)return;const c={id:uid("campaign"),name,tripId,city,hotelIds:t?[...(A().state.shortlists[t.id]||[])]:[],createdAt:new Date().toISOString()};data.campaigns.unshift(c);persist();A().closeModal();ui.campaign=c.id;showCampaigns();A().toast("Campaign created")}
if(e.target.id==="ops-add-form"){e.preventDefault();const c=data.campaigns.find(c=>c.id===ui.campaign);for(const input of e.target.querySelectorAll('input[name="hotel"]:checked'))if(!c.hotelIds.includes(input.value))c.hotelIds.push(input.value);persist();A().closeModal();showCampaigns();A().toast("Hotels added")}
});
document.addEventListener("keydown",e=>{
if(e.key==="Escape"&&ui.drawer&&!E("modal-root")?.classList.contains("open"))drawerClose();
if((e.key==="Enter"||e.key===" ")&&e.target.classList.contains("ops-deal")){e.preventDefault();drawerOpen(e.target.dataset.opDeal)}
});
document.addEventListener("dragstart",e=>{const c=e.target.closest(".ops-deal");if(c)e.dataTransfer.setData("text/plain",c.dataset.opDeal)});
document.addEventListener("dragover",e=>{const lane=e.target.closest(".ops-lane");if(lane){e.preventDefault();lane.classList.add("over")}});
document.addEventListener("dragleave",e=>{const lane=e.target.closest(".ops-lane");if(lane)lane.classList.remove("over")});
document.addEventListener("drop",e=>{const lane=e.target.closest(".ops-lane");if(!lane)return;e.preventDefault();lane.classList.remove("over");const id=e.dataTransfer.getData("text/plain");if(hotel(id))stageChange(id,lane.dataset.stage)});
})();