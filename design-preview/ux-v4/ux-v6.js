(function V6(){
"use strict";
const A=()=>window.UXApp,E=id=>document.getElementById(id),esc=v=>A().esc(v==null?"":String(v)),ic=n=>A().ic(n);
const get=(k,d)=>{try{let v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},put=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}};
const hotel=id=>A().H.find(h=>h.id===id),trip=id=>A().tripById(id),uid=p=>p+"-"+Date.now()+"-"+Math.floor(Math.random()*1e6),date=s=>s?new Date(s).toLocaleDateString("en-US",{month:"short",day:"numeric"}):"—";
const labels={saved:"Saved",draft:"Pitch ready",sent:"Outreach sent",replied:"Hotel replied",negotiating:"Negotiating",won:"Agreement reached",bounced:"Bounce reported",closed:"Closed"};
const group=s=>s==="negotiating"?"replied":s==="bounced"?"sent":s;
let db={campaigns:[],opportunities:[],events:[],notes:[],drafts:[]};
let ui={campaign:"",scope:"all",trip:"",stage:"all",search:"",view:"board",drawer:"",closed:false};
function load(){
 db.campaigns=get("ugc_v4_campaigns",[]);db.opportunities=get("ugc_v6_opportunities",[]);db.events=get("ugc_v6_events",[]);db.notes=get("ugc_v6_notes",[]);db.drafts=get("ugc_v4_drafts",[]);
}
function save(){put("ugc_v4_campaigns",db.campaigns);put("ugc_v6_opportunities",db.opportunities);put("ugc_v6_events",db.events);put("ugc_v6_notes",db.notes)}
function reconcileLegacy(){
 let changed=false;
 for(const draft of db.drafts){
   if(!hotel(draft.hotelId))continue;
   const cid=draft.campaignId||"";
   const matching=db.opportunities.filter(o=>o.hotelId===draft.hotelId&&(cid?o.campaignId===cid:!o.campaignId));
   const found=matching[0]||(cid?ensure(draft.hotelId,cid,db.campaigns.find(c=>c.id===cid)?.tripId||""):ensure(draft.hotelId,"",""));
   if(found&&found.status==="saved"){found.status="draft";found.updatedAt=draft.updatedAt||new Date().toISOString();changed=true}
 }
 const seen=new Set(get("ugc_v6_seen_legacy_events",[]));
 const legacy=get("ugc_v4_events",[]);
 for(const e of legacy){
   if(!e.id||seen.has(e.id)||e.type!=="stage")continue;
   if(e.source==="sample"||e.source==="demo"){seen.add(e.id);continue}
   const matches=db.opportunities.filter(o=>o.hotelId===e.hotelId&&(e.opportunityId?o.id===e.opportunityId:e.campaignId?o.campaignId===e.campaignId:!o.campaignId));
   if(matches.length!==1){if(!matches.length&&e.hotelId&&!e.campaignId){matches.push(ensure(e.hotelId,"",""))}else continue}
   const o=matches[0];
   if(o&&labels[e.value]){o.status=e.value;o.updatedAt=e.at||new Date().toISOString();db.events.push({id:uid("legacy"),opportunityId:o.id,value:e.value,type:"stage",at:o.updatedAt,source:"manual-import"});changed=true}
   seen.add(e.id);
 }
 put("ugc_v6_seen_legacy_events",[...seen]);if(changed)save();
}
function opportunity(id){return db.opportunities.find(o=>o.id===id)}
function ensure(hotelId,campaignId="",tripId=""){
 if(!hotel(hotelId))return null;
 const o=db.opportunities.find(o=>o.hotelId===hotelId&&o.campaignId===campaignId);
 if(o)return o;
 const v={id:uid("opp"),hotelId,campaignId,tripId,status:"saved",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};db.opportunities.push(v);return v;
}
function forCampaign(id){return db.opportunities.filter(o=>o.campaignId===id&&hotel(o.hotelId))}
function campaignsForTrip(id){return db.campaigns.filter(c=>c.tripId===id)}
function seedOrMigrate(){
 if(get("ugc_v6_initialized",false))return;
 if(!db.campaigns.length&&!A().state.pipeline.length){
   const t=A().state.trips.find(t=>t.city==="Bangkok");
   db.campaigns=[{id:"demo-trip",name:"Bangkok · November outreach",city:"Bangkok",tripId:t?.id||"",hotelIds:["canopy","riverline","atelier","garden"],sample:true},{id:"demo-independent",name:"Bangkok · Luxury storytelling",city:"Bangkok",tripId:"",hotelIds:["canopy","lantern"],sample:true}];
   [["canopy","demo-trip","replied"],["riverline","demo-trip","sent"],["atelier","demo-trip","draft"],["garden","demo-trip","saved"],["canopy","demo-independent","draft"],["lantern","demo-independent","saved"]].forEach(([h,c,s])=>{const o=ensure(h,c,c==="demo-trip"?t?.id||"":"");o.status=s;o.sample=true});
   if(t){if(!A().state.shortlists[t.id])A().state.shortlists[t.id]=[];for(const id of ["canopy","riverline","atelier","garden"]){if(!A().state.shortlists[t.id].includes(id))A().state.shortlists[t.id].push(id)}}
   for(const id of ["canopy","riverline","atelier","garden","lantern"]){if(!A().state.pipeline.includes(id))A().state.pipeline.push(id)}
   A().saveState();
   const drafts=[
    {id:"v6-demo-draft-1",hotelId:"atelier",campaignId:"demo-trip",subject:"UGC content collaboration · Atelier Sukhumvit",body:"Illustrative draft only. No email was sent. Please personalize before using.",updatedAt:new Date().toISOString(),sample:true},
    {id:"v6-demo-draft-2",hotelId:"canopy",campaignId:"demo-independent",subject:"Luxury storytelling idea · Siam Canopy",body:"Illustrative draft only. No email was sent. Please personalize before using.",updatedAt:new Date().toISOString(),sample:true}
   ];
   db.drafts.push(...drafts);put("ugc_v4_drafts",db.drafts);
   put("ugc_v6_sample",true);
 }else{
   const events=get("ugc_v4_events",[]);
   db.campaigns.forEach(c=>(c.hotelIds||[]).forEach(h=>{
     const o=ensure(h,c.id,c.tripId||"");
     const isOnlyCampaign=db.campaigns.filter(x=>(x.hotelIds||[]).includes(h)).length===1;
     const ev=events.filter(e=>e.hotelId===h&&e.type==="stage"&&(e.campaignId?e.campaignId===c.id:isOnlyCampaign)).at(-1);
     if(ev&&labels[ev.value])o.status=ev.value;
     else if(db.drafts.some(d=>d.hotelId===h&&(d.campaignId||"")===c.id))o.status="draft";
   }));
   const used=new Set(db.opportunities.map(o=>o.hotelId));
   A().state.pipeline.forEach(id=>{if(!used.has(id)){ensure(id);used.add(id)}});
 }
 save();put("ugc_v6_initialized",true);
}
function count(items){return {total:items.length,prepared:items.filter(o=>db.drafts.some(d=>d.hotelId===o.hotelId&&(!o.campaignId||d.campaignId===o.campaignId))).length,sent:items.filter(o=>["sent","replied","negotiating","won","bounced"].includes(o.status)).length,replies:items.filter(o=>["replied","negotiating","won"].includes(o.status)).length}}
function stats(items){
 const n=count(items);return [["Opportunities",n.total,"Separate commercial attempts"],["Pitches saved",n.prepared,"Drafts linked by hotel"],["Outreach logged",n.sent,"Manual or demo events"],["Conversations",n.replies,"Manual or demo outcomes"]].map(([name,num,sub],i)=>`<div class="ops-stat ${i===3?"highlight":""}"><span class="k">${name}</span><strong>${num}</strong><small>${sub}</small></div>`).join("")
}
function badge(s){return `<span class="ops-pill ${["replied","won"].includes(s)?"lime":s==="sent"?"blue":s==="negotiating"?"amber":""}">${esc(labels[s]||"Saved")}</span>`}
function fromTrip(id,importNew=false){
 const t=trip(id);if(!t)return;
 let c=campaignsForTrip(id)[0],existing=Boolean(c);
 if(!c){c={id:uid("outreach"),name:t.city+" · Outreach",city:t.city,tripId:id,hotelIds:[],createdAt:new Date().toISOString()};db.campaigns.unshift(c)}
 if(!existing||importNew){for(const hid of A().state.shortlists[id]||[]){if(!c.hotelIds.includes(hid))c.hotelIds.push(hid);ensure(hid,c.id,id)}}
 save();return c;
}
function tripCard(t){
 const hs=(A().state.shortlists[t.id]||[]).filter(h=>hotel(h)),os=db.opportunities.filter(o=>o.tripId===t.id),n=count(os),campaigns=campaignsForTrip(t.id);
 return `<article class="v6-trip-card"><div class="v6-trip-cover"><span class="ops-pill dark">${ic("calendar")} ${esc(date(t.start))} – ${esc(date(t.end))}</span><div><small>MY TRIP · ${esc(t.city).toUpperCase()}</small><h3>${esc(t.name)}</h3></div></div><div class="v6-trip-body"><div class="v6-trip-stats"><div class="v6-trip-stat"><strong>${hs.length}</strong><small>Shortlisted</small></div><div class="v6-trip-stat"><strong>${n.sent}</strong><small>Outreach logged</small></div><div class="v6-trip-stat"><strong>${n.replies}</strong><small>Conversations</small></div></div><div class="v6-trip-preview">${campaigns.length?`<strong>${campaigns.length} linked outreach ${campaigns.length===1?"initiative":"initiatives"}</strong>`:"Organize hotels now; start outreach when you're ready."}</div><div class="v6-trip-actions"><button class="btn lime" data-v6-start-trip="${esc(t.id)}">${campaigns.length?"Continue outreach":"Start outreach"} ${ic("arrow")}</button><a class="btn" href="discover.html?trip=${encodeURIComponent(t.id)}">Explore hotels</a></div>${hs.length?`<div class="v6-trip-preview"><strong>Shortlisted:</strong> ${hs.slice(0,3).map(id=>esc(hotel(id)?.name)).join(" · ")}${hs.length>3?` +${hs.length-3} more`:""}</div>`:""}</div></article>`;
}
function renderTrips(){
 if(document.body.dataset.page!=="trips")return;
 load();E("v6-trips-count").textContent=A().state.trips.length+" trips";
 E("trips-view").innerHTML=A().state.trips.length?`<div class="v6-trip-grid">${A().state.trips.map(tripCard).join("")}</div>`:`<div class="ops-emptybox"><h3>No trips yet</h3><p>Create a trip to plan dates and build a shortlist.</p><button class="btn lime" data-create-trip>Create trip</button></div>`;
}
function createOutreachModal(){
 A().modal("Start outreach",`<p>Choose a destination or select an existing Trip. A Trip's shortlisted hotels will be included automatically.</p><form id="v6-new-outreach"><div class="field" style="margin:14px 0"><label for="v6-new-name">OUTREACH NAME</label><input id="v6-new-name" required maxlength="100" placeholder="e.g. Bali January outreach"></div><div class="modal-fields"><div class="field"><label for="v6-new-trip">TRIP (OPTIONAL)</label><select id="v6-new-trip"><option value="">No trip</option>${A().state.trips.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select></div><div class="field"><label for="v6-new-city">DESTINATION</label><select id="v6-new-city">${[...new Set(A().H.map(h=>h.city))].map(c=>`<option>${esc(c)}</option>`).join("")}</select></div></div><p class="fine">Hotel details stay shared. An attempt to collaborate with a hotel belongs to this initiative.</p><div class="modal-bottom"><button class="btn" type="button" data-close>Cancel</button><button type="submit" class="btn lime">Start outreach</button></div></form>`);
}
function addLeads(){
 const c=db.campaigns.find(c=>c.id===ui.campaign);if(!c)return;
 const others=A().H.filter(h=>h.city===c.city&&!(c.hotelIds||[]).includes(h.id));
 A().modal("Add hotels",`<p>Select from the same hotel catalog used by Discover and My Trips.</p><form id="v6-add-leads"><div style="max-height:300px;overflow:auto">${others.length?others.map(h=>`<label class="choice-card"><input type="checkbox" name="hotel" value="${esc(h.id)}"><span><strong>${esc(h.name)}</strong><small>${esc(h.type)} · ${esc(h.city)}</small></span></label>`).join(""):"<p>No more hotels in this destination.</p>"}</div><div class="modal-bottom"><button class="btn" type="button" data-close>Cancel</button><button class="btn lime" type="submit">Add selected</button></div></form>`);
}
function renderLeadTable(c){
 const os=forCampaign(c.id).filter(o=>(!ui.search||hotel(o.hotelId).name.toLowerCase().includes(ui.search.toLowerCase()))&&(ui.stage==="all"||group(o.status)===ui.stage));
 E("ops-lead-count").textContent=os.length+" visible";
 E("ops-campaign-rows").innerHTML=os.length?os.map(o=>{
 const h=hotel(o.hotelId);
 return `<tr><td><div class="ops-lead-ident"><span class="ops-ident-mark">${esc(h.name.split(" ").slice(0,2).map(w=>w[0]).join(""))}</span><div><strong>${esc(h.name)}</strong><small>${esc(h.city)} · ${esc(h.type)}</small><small>Opportunity #${esc(o.id.slice(-6))}</small></div></div></td><td>${badge(o.status)}</td><td><span class="ops-pill">${esc(h.activity)} activity</span></td><td><strong>${db.drafts.some(d=>d.hotelId===o.hotelId)?"Draft available":"No pitch yet"}</strong><small style="display:block;margin-top:5px;color:#778477">${A().state.unlocks.includes(h.id)?"Contact unlocked (demo)":"Contact locked"}</small></td><td><button class="btn small" data-v6-open="${esc(o.id)}">Work on it ${ic("arrow")}</button></td></tr>`;
 }).join(""):'<tr><td colspan="5" class="ops-no-data">No leads match this filter.</td></tr>';
}
function renderCampaign(){
 if(document.body.dataset.page!=="campaigns")return;load();
 const params=new URLSearchParams(location.search);
 let c=db.campaigns.find(c=>c.id===(params.get("campaign")||ui.campaign))||db.campaigns[0];
 ui.campaign=c?.id||"";
 E("ops-campaign-pills").innerHTML=db.campaigns.length?db.campaigns.map(x=>{const n=count(forCampaign(x.id)),active=x.id===ui.campaign;
 return `<button class="ops-chooser-card ${active?"active":""}" data-v6-campaign="${esc(x.id)}" aria-pressed="${active}"><div class="ops-chooser-title"><span class="ops-chooser-pin">${ic("pin")}</span><span class="ops-pill">${x.tripId?"Linked trip":"Independent"}</span></div><strong>${esc(x.name)}</strong><small>${esc(x.city)} · ${n.total} opportunities</small><div class="ops-track" style="height:5px;margin-top:15px;background:#E2ECDD"><div class="ops-fill" style="width:${n.total?n.sent/n.total*100:0}%"></div></div></button>`;
 }).join(""):'<div class="ops-emptybox"><h3>Your first outreach starts here.</h3><p>Choose a destination or start from My Trips.</p><button class="btn lime" data-v6-new>Start outreach</button></div>';
 E("ops-campaign-workspace").hidden=!c;E("ops-campaign-none").hidden=!!c;if(!c)return;
 const os=forCampaign(c.id),n=count(os),t=trip(c.tripId);
 E("ops-campaign-city").textContent=c.city.toUpperCase()+(t?" / "+t.name:" / INDEPENDENT OUTREACH");
 E("ops-campaign-title").textContent=c.name;
 E("ops-campaign-desc").textContent=t?"Linked to "+t.name+". Shortlisted hotels are imported without re-entering them.":"No dates required. Organize your commercial outreach before confirming a trip.";
 E("ops-campaign-progress-title").textContent=n.sent+" / "+n.total;E("ops-progress-percent").textContent=(n.total?Math.round(n.sent/n.total*100):0)+"%";
 E("ops-campaign-progress").style.width=(n.total?n.sent/n.total*100:0)+"%";
 E("ops-stat-grid").innerHTML=stats(os);E("ops-campaign-id").textContent=os.length+" opportunities";
 const next=os.find(o=>["replied","negotiating"].includes(o.status))||os.find(o=>o.status==="draft")||os[0];
 E("ops-focus-card").innerHTML=next?`<div class="eyebrow">NEXT BEST ACTION</div><h3>${["replied","negotiating"].includes(next.status)?"Continue the conversation":next.status==="draft"?"Review the saved pitch":"Prepare your next proposal"}</h3><p>${esc(hotel(next.hotelId).name)} · ${esc(labels[next.status])}</p><a class="btn lime" href="pipeline.html?opp=${encodeURIComponent(next.id)}">Open opportunity ${ic("arrow")}</a>`:'<div class="eyebrow">GET STARTED</div><h3>Add hotel leads</h3><p>Select hotels from Discover or import from your Trip.</p><button class="btn lime" data-v6-add>Add hotels</button>';
 const queued=t?(A().state.shortlists[t.id]||[]).filter(id=>!(c.hotelIds||[]).includes(id)):[];
 E("v6-campaign-trip-context").hidden=!t;
 if(t)E("v6-campaign-trip-context").innerHTML=`<div><strong>${esc(t.name)} is linked.</strong><br><small>New Trip hotels are optional until imported.</small></div><div class="ops-controls"><span class="ops-pill">${queued.length} new hotels</span><button class="btn small" data-v6-import="${esc(t.id)}">Import from Trip</button><a class="btn small" href="my-trips.html">View Trip →</a></div>`;
 renderLeadTable(c);
 const events=db.events.filter(e=>os.some(o=>o.id===e.opportunityId)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,6);
 E("ops-campaign-events").innerHTML=events.length?events.map(e=>{let o=opportunity(e.opportunityId);return `<div class="ops-event"><strong>${esc(hotel(o?.hotelId)?.name||"Hotel")}</strong><p>${esc(labels[e.value])} · manual local event</p><small>${date(e.at)}</small></div>`}).join(""):'<div class="ops-no-data">No outreach events yet.</div>';
}
function visible(){
 return db.opportunities.filter(o=>hotel(o.hotelId)).filter(o=>(ui.closed||o.status!=="closed")&&(ui.scope!=="trips"||o.tripId)&&(ui.scope!=="independent"||!o.tripId)&&(!ui.trip||o.tripId===ui.trip)&&(ui.stage==="all"||(ui.stage==="conversation"?["replied","negotiating"].includes(o.status):group(o.status)===ui.stage))&&(!ui.search||hotel(o.hotelId).name.toLowerCase().includes(ui.search.toLowerCase())));
}
function renderPipeline(){
 if(document.body.dataset.page!=="pipeline")return;load();
 const os=visible(),n=count(os);
 E("ops-pipeline-count").textContent=os.length;E("ops-pipeline-summary").textContent=os.length+" commercial opportunities · "+n.replies+" conversations";
 E("ops-pipeline-hero-action").textContent=n.replies?n.replies+" conversations in motion":"Make every outreach count.";
 E("ops-pipeline-progress").style.width=(n.total?n.sent/n.total*100:0)+"%";
 E("ops-pipeline-stats").innerHTML=stats(os);
 const priorities=[...os.filter(o=>["replied","negotiating"].includes(o.status)),...os.filter(o=>o.status==="sent"),...os.filter(o=>o.status==="draft"),...os.filter(o=>o.status==="saved")].slice(0,3);
 E("ops-priority-cards").innerHTML=priorities.length?priorities.map(o=>`<button class="ops-task" data-v6-open="${esc(o.id)}"><span class="ops-pill">${esc(labels[o.status])}</span><strong>${esc(hotel(o.hotelId).name)}</strong><small>${esc(db.campaigns.find(c=>c.id===o.campaignId)?.name||"Independent")} · Open next step →</small></button>`).join(""):'<div class="ops-emptybox"><h3>All clear for now</h3><p>Start with Discover or My Trips.</p></div>';
 for(const v of ["board","list","timeline"]){E("ops-deal-"+v).hidden=ui.view!==v;document.querySelectorAll('[data-op-view="'+v+'"]').forEach(b=>b.classList.toggle("active",ui.view===v))}
 const lanes=[["saved","Saved"],["draft","Pitch ready"],["sent","Outreach sent"],["replied","In conversation"],["won","Agreed"],...(ui.closed?[["closed","Closed"]]:[])];
 E("ops-deal-board").innerHTML=lanes.map(([stage,label])=>`<section class="ops-lane" data-v6-stage="${stage}"><div class="ops-lane-head"><strong>${label}</strong><small>${os.filter(o=>group(o.status)===stage).length}</small></div><div class="ops-lane-stack">${os.filter(o=>group(o.status)===stage).map(o=>{
 let h=hotel(o.hotelId),c=db.campaigns.find(c=>c.id===o.campaignId);
 return `<article class="ops-deal" data-v6-open="${esc(o.id)}" draggable="true" tabindex="0" role="button"><div class="ops-deal-top"><span class="ops-initial">${esc(h.name.slice(0,2).toUpperCase())}</span>${badge(o.status)}</div><h3>${esc(h.name)}</h3><p>${esc(h.city)} · ${esc(c?.name||"Independent")}</p><div class="v6-opp-scope"><span class="v6-opp-tag">${esc(trip(o.tripId)?.name||"No trip")}</span><span class="v6-opp-tag">#${esc(o.id.slice(-6))}</span></div><div class="ops-deal-foot"><span>Open opportunity</span>${ic("arrow")}</div></article>`;
 }).join("")}</div></section>`).join("");
 E("ops-deal-list").innerHTML=os.length?os.map(o=>{const h=hotel(o.hotelId),c=db.campaigns.find(c=>c.id===o.campaignId);return `<div class="ops-list-item"><div><strong>${esc(h.name)}</strong><br><small>${esc(c?.name||"Independent")}</small></div><div>${badge(o.status)}</div><div><small>${esc(trip(o.tripId)?.name||"No trip")}</small></div><div><small>#${esc(o.id.slice(-6))}</small></div><button class="btn small" data-v6-open="${esc(o.id)}">Details</button></div>`}).join(""):'<div class="ops-no-data">No opportunities in this view.</div>';
 const events=db.events.filter(e=>os.some(o=>o.id===e.opportunityId)).sort((a,b)=>b.at.localeCompare(a.at));
 E("ops-deal-timeline").innerHTML=events.length?events.map(e=>{const o=opportunity(e.opportunityId);return `<div class="ops-event"><strong>${esc(hotel(o?.hotelId)?.name)} · ${esc(labels[e.value])}</strong><p>${esc(db.campaigns.find(c=>c.id===o?.campaignId)?.name||"Independent")} · manual event</p><small>${date(e.at)} <button class="v6-link" data-v6-open="${esc(o.id)}">Open →</button></small></div>`}).join(""):'<div class="ops-no-data">No timeline events yet.</div>';
 E("v6-scope-trip").innerHTML='<option value="">All trips</option>'+A().state.trips.map(t=>`<option value="${esc(t.id)}" ${ui.trip===t.id?"selected":""}>${esc(t.name)}</option>`).join("");
 document.querySelectorAll("[data-v6-scope]").forEach(b=>b.classList.toggle("active",b.dataset.v6Scope===ui.scope));
}
function drawerOpen(id){
 if(!opportunity(id))return;ui.drawer=id;E("ops-drawer").inert=false;E("ops-drawer").classList.add("open");E("ops-drawer").setAttribute("aria-hidden","false");E("ops-drawer-shade").classList.add("visible");document.body.style.overflow="hidden";drawerRender();E("ops-drawer-close")?.focus();
}
function drawerClose(){ui.drawer="";E("ops-drawer").classList.remove("open");E("ops-drawer").inert=true;E("ops-drawer").setAttribute("aria-hidden","true");E("ops-drawer-shade").classList.remove("visible");document.body.style.overflow=""}
function drawerRender(){
 const o=opportunity(ui.drawer);if(!o)return;const h=hotel(o.hotelId),c=db.campaigns.find(c=>c.id===o.campaignId),others=db.opportunities.filter(x=>x.hotelId===h.id&&x.id!==o.id);
 const activity=db.events.filter(x=>x.opportunityId===o.id).map(x=>({at:x.at,label:labels[x.value]})).concat(db.notes.filter(x=>x.opportunityId===o.id).map(x=>({at:x.at,label:x.text}))).sort((x,y)=>y.at.localeCompare(x.at));
 E("ops-drawer-content").innerHTML=`<div class="eyebrow">ONE HOTEL · SEPARATE OPPORTUNITIES</div><h2>${esc(h.name)}</h2><p>${esc(h.city)} · ${esc(h.type)}</p><div class="ops-drawer-info"><div class="side-row"><span>Outreach</span><b>${esc(c?.name||"Independent")}</b></div><div class="side-row"><span>Trip</span><b>${esc(trip(o.tripId)?.name||"None")}</b></div><div class="side-row"><span>Stage</span><b>${esc(labels[o.status])}</b></div><div class="side-row"><span>Contact</span><b>${A().state.unlocks.includes(h.id)?"Unlocked for this hotel (demo)":"Locked"}</b></div><div class="side-row"><span>Opportunity</span><b>#${esc(o.id.slice(-8))}</b></div></div><div class="v6-panel-highlight">The hotel's identity and unlocked contact are shared. This opportunity has its own history and stage.</div><div class="field"><label for="v6-stage">CHANGE STAGE</label><select id="v6-stage" class="v6-status-select">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${k===o.status?"selected":""}>${v}</option>`).join("")}</select></div><button class="btn lime wide" data-v6-stage-save>Save stage update</button><p class="ops-micro">Manual status updates are not verified network signals.</p><div class="ops-divider"></div><h3>Next steps</h3><div class="ops-drawer-actions"><a href="pitch.html?hotel=${encodeURIComponent(h.id)}&campaign=${encodeURIComponent(c?.id||"")}" class="btn dark">Pitch Studio</a><a href="hotel.html?id=${encodeURIComponent(h.id)}" class="btn">Hotel Detail</a><a href="contract-review.html?hotel=${encodeURIComponent(h.id)}&opp=${encodeURIComponent(o.id)}" class="btn">Contract Review</a><a href="inbox.html" class="btn">Inbox</a></div><div class="ops-divider"></div><h3>Notes for this opportunity</h3><textarea id="v6-note" placeholder="What happened and what comes next?"></textarea><button class="btn small" data-v6-note-add style="margin-top:9px">Add note</button>${others.length?`<div class="ops-divider"></div><h3>Other attempts with this hotel</h3>${others.map(x=>`<div class="v6-related-row"><div><strong>${esc(db.campaigns.find(c=>c.id===x.campaignId)?.name||"Independent")}</strong><small>${esc(labels[x.status])}</small></div><button class="btn small" data-v6-open="${esc(x.id)}">Open</button></div>`).join("")}`:""}<div class="ops-divider"></div><h3>Activity</h3>${activity.length?activity.map(x=>`<div class="ops-event"><strong>${esc(x.label)}</strong><small>${date(x.at)}</small></div>`).join(""):'<p class="fine">No activity yet.</p>'}`;
}
function stageChange(o,v){
 if(!o||o.status===v)return;
 if(A().state.plan==="free"&&["draft","sent","replied","negotiating","won","bounced"].includes(v)&&!["draft","sent","replied","negotiating","won","bounced"].includes(o.status)){
 const active=db.opportunities.filter(x=>x.id!==o.id&&["draft","sent","replied","negotiating","won","bounced"].includes(x.status)).length;
 if(active>=5){A().upgrade("Free allows up to five active outreach opportunities. Upgrade for a larger working Pipeline.");return}
 }
 if(["sent","replied","negotiating","won","bounced"].includes(v)){A().modal("Confirm manual update",`<p>Record <strong>${esc(hotel(o.hotelId).name)}</strong> as <strong>${esc(labels[v])}</strong>? This does not verify a Gmail message or confirm a collaboration.</p><div class="modal-bottom"><button class="btn" data-close>Cancel</button><button class="btn lime" data-v6-confirm="${esc(o.id)}" data-v6-next="${esc(v)}">Confirm</button></div>`)}
 else stageApply(o,v);
}
function stageApply(o,v){
 o.status=v;o.updatedAt=new Date().toISOString();db.events.push({id:uid("event"),opportunityId:o.id,value:v,type:"stage",at:o.updatedAt,source:"manual"});
 if(["sent","replied","won","bounced"].includes(v)){const ev={id:uid("op-event"),opportunityId:o.id,hotelId:o.hotelId,campaignId:o.campaignId||"",type:"stage",value:v,at:o.updatedAt,source:"manual"};const old=get("ugc_v4_events",[]);old.push(ev);put("ugc_v4_events",old);const seen=get("ugc_v6_seen_legacy_events",[]);seen.push(ev.id);put("ugc_v6_seen_legacy_events",seen)}
 save();A().closeModal();renderPipeline();if(ui.drawer){document.body.style.overflow="hidden";drawerRender()}A().toast("Manual stage updated");
}
function boot(){
 if(!["trips","campaigns","pipeline"].includes(document.body.dataset.page))return;
 load();seedOrMigrate();load();reconcileLegacy();
 if(document.body.dataset.page==="trips")renderTrips();
 if(document.body.dataset.page==="campaigns"){const p=new URLSearchParams(location.search);if(p.get("trip")&&p.get("start")==="1"){const c=fromTrip(p.get("trip"));if(c){history.replaceState({},'',location.pathname+"?campaign="+encodeURIComponent(c.id))}}renderCampaign()}
 if(document.body.dataset.page==="pipeline"){const p=new URLSearchParams(location.search);ui.stage=p.get("filter")==="conversation"?"conversation":p.get("filter")||"all";renderPipeline();if(p.get("opp"))setTimeout(()=>drawerOpen(p.get("opp")),130)}
}
document.addEventListener("DOMContentLoaded",boot);
document.addEventListener("click",e=>{
 const b=e.target.closest("[data-v6-start-trip],[data-v6-campaign],[data-v6-new],[data-v6-import],[data-v6-add],[data-v6-open],[data-v6-scope],[data-v6-stage-save],[data-v6-confirm],[data-v6-note-add],[data-v6-closed],[data-v6-drawer-close],[data-op-view]");
 if(!b)return;
 if(b.dataset.v6StartTrip){const c=fromTrip(b.dataset.v6StartTrip);if(c)location.href="campaigns.html?campaign="+encodeURIComponent(c.id)}
 if(b.dataset.v6Campaign){ui.campaign=b.dataset.v6Campaign;ui.search="";ui.stage="all";history.replaceState({},'',location.pathname+"?campaign="+encodeURIComponent(ui.campaign));E("ops-lead-search").value="";E("ops-lead-stage").value="all";renderCampaign()}
 if(b.hasAttribute("data-v6-new"))createOutreachModal();
 if(b.dataset.v6Import){fromTrip(b.dataset.v6Import,true);renderCampaign();A().toast("New Trip hotels imported")}
 if(b.hasAttribute("data-v6-add"))addLeads();
 if(b.dataset.v6Open){if(document.body.dataset.page==="campaigns")location.href="pipeline.html?opp="+encodeURIComponent(b.dataset.v6Open);else drawerOpen(b.dataset.v6Open)}
 if(b.dataset.v6Scope){ui.scope=b.dataset.v6Scope;if(ui.scope!=="trips")ui.trip="";renderPipeline()}
 if(b.dataset.opView){ui.view=b.dataset.opView;renderPipeline()}
 if(b.hasAttribute("data-v6-stage-save"))stageChange(opportunity(ui.drawer),E("v6-stage").value);
 if(b.dataset.v6Confirm)stageApply(opportunity(b.dataset.v6Confirm),b.dataset.v6Next);
 if(b.hasAttribute("data-v6-note-add")){const text=E("v6-note")?.value.trim();if(!text)return A().toast("Write a note first");db.notes.push({id:uid("note"),opportunityId:ui.drawer,text,at:new Date().toISOString()});save();drawerRender();A().toast("Note saved")}
 if(b.hasAttribute("data-v6-closed")){ui.closed=!ui.closed;b.textContent=ui.closed?"Hide closed":"Include closed";renderPipeline()}
 if(b.hasAttribute("data-v6-drawer-close"))drawerClose();
});
document.addEventListener("change",e=>{
 if(e.target.id==="ops-lead-stage"){ui.stage=e.target.value;renderCampaign()}
 if(e.target.id==="ops-pipeline-stage"){ui.stage=e.target.value;renderPipeline()}
 if(e.target.id==="v6-scope-trip"){ui.trip=e.target.value;ui.scope="trips";renderPipeline()}
 if(e.target.id==="v6-new-trip"){let t=trip(e.target.value);if(t)E("v6-new-city").value=t.city}
});
document.addEventListener("input",e=>{
 if(e.target.id==="ops-lead-search"){ui.search=e.target.value;renderCampaign()}
 if(e.target.id==="ops-pipeline-search"){ui.search=e.target.value;renderPipeline()}
});
document.addEventListener("submit",e=>{
 if(e.target.id==="v6-new-outreach"){e.preventDefault();const name=E("v6-new-name").value.trim(),tid=E("v6-new-trip").value,t=trip(tid),city=t?t.city:E("v6-new-city").value;if(!name)return;const c={id:uid("outreach"),name,tripId:tid,city,hotelIds:t?[...(A().state.shortlists[tid]||[])]:[]};db.campaigns.unshift(c);c.hotelIds.forEach(h=>ensure(h,c.id,tid));save();A().closeModal();location.href="campaigns.html?campaign="+encodeURIComponent(c.id)}
 if(e.target.id==="v6-add-leads"){e.preventDefault();const c=db.campaigns.find(c=>c.id===ui.campaign);for(const x of e.target.querySelectorAll("input[name=hotel]:checked")){if(!c.hotelIds.includes(x.value))c.hotelIds.push(x.value);ensure(x.value,c.id,c.tripId||"")}save();A().closeModal();renderCampaign();A().toast("Hotels added")}
 if(e.target.id==="create-trip-form")setTimeout(renderTrips,0);
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&ui.drawer&&!E("modal-root")?.classList.contains("open"))drawerClose();if((e.key==="Enter"||e.key===" ")&&e.target.matches(".ops-deal")){e.preventDefault();drawerOpen(e.target.dataset.v6Open)}});
document.addEventListener("click",e=>{if(e.target.id==="ops-drawer-shade")drawerClose()});
document.addEventListener("dragstart",e=>{const card=e.target.closest(".ops-deal");if(card)e.dataTransfer?.setData("text/plain",card.dataset.v6Open)});
document.addEventListener("dragover",e=>{const lane=e.target.closest("[data-v6-stage]");if(lane){e.preventDefault();lane.classList.add("over")}});
document.addEventListener("dragleave",e=>{const lane=e.target.closest("[data-v6-stage]");if(lane)lane.classList.remove("over")});
document.addEventListener("drop",e=>{const lane=e.target.closest("[data-v6-stage]");if(lane){e.preventDefault();lane.classList.remove("over");const id=e.dataTransfer?.getData("text/plain");if(id)stageChange(opportunity(id),lane.dataset.v6Stage)}});
})();