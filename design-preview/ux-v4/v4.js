/* theugc.life UX V4: connected, local-only creator workspace. Never sends an email, spends real credits or processes uploaded contracts. */
(function(){
'use strict';
const a=()=>window.UXApp;
const get=(key,fallback)=>{try{let x=localStorage.getItem('ugc_v4_'+key);return x?JSON.parse(x):fallback}catch(e){return fallback}};
const set=(key,value)=>{try{localStorage.setItem('ugc_v4_'+key,JSON.stringify(value))}catch(e){}};
const $=id=>document.getElementById(id);
const html=(str)=>a().esc(str);
const date=(iso)=>{if(!iso)return 'Date not set';const d=new Date(iso+'T12:00:00');return Number.isNaN(d.getTime())?iso:d.toLocaleDateString('en-US',{month:'short',day:'numeric'})};
const st={
campaigns:get('campaigns',[]),
drafts:get('drafts',[]),
events:get('events',[]),
contracts:get('contracts',[]),
savedSearches:get('savedSearches',[]),
recentSearch:get('recentSearch',null),
lastHotel:get('lastHotel',null)
};
const persist=()=>Object.keys(st).forEach(k=>set(k,st[k]));
const findHotel=id=>a().H.find(h=>h.id===id);
const findCampaign=id=>st.campaigns.find(x=>x.id===id);
const findDraft=(hotelId,campaignId)=>st.drafts.find(x=>x.hotelId===hotelId&&(x.campaignId||'')===(campaignId||''));
const qs=()=>new URLSearchParams(location.search);
const hotelLink=(id)=>'hotel.html?id='+encodeURIComponent(id)+(a().state.trip?'&trip='+encodeURIComponent(a().state.trip):'');
const icon=n=>a().ic(n);
const stripTags=v=>String(v||'').replace(/<[^>]*>/g,'');
const allSaved=()=>[...new Set([...a().state.pipeline,...Object.values(a().state.shortlists).flat()])];
const activePlan=()=>a().state.plan;
const label=(v)=>v==='not-started'?'Not started':v==='draft'?'Draft ready':v==='sent'?'Sent · manual':v==='replied'?'Replied · manual':v==='won'?'Won · manual':v==='closed'?'Closed':v;
const stageColors={sent:'outlined',replied:'success',won:'success',draft:'outlined'};
const badge=(v)=>'<span class="badge '+(stageColors[v]||'')+'">'+html(label(v))+'</span>';
const stageValue=(hotelId)=>{let m=st.events.filter(e=>e.hotelId===hotelId&&e.type==='stage').at(-1);return m?m.value:(st.drafts.some(d=>d.hotelId===hotelId)?'draft':'not-started')};
const stages=['not-started','draft','sent','replied','won','closed'];
const newId=prefix=>prefix+'-'+Date.now()+'-'+Math.floor(Math.random()*1e6);
const inputValue=id=>($(id)?.value||'').trim();
function syncAll(){
  a().state.pipeline.forEach(id=>{ if(!findHotel(id))return; });
  a().saveState();persist();
}
function actionLead(h,cam){
 return '<div class="campaign-lead"><div><strong>'+html(h.name)+'</strong><div class="fine">'+html(h.city)+' · '+html(h.type)+'</div></div><div>'+badge(stageValue(h.id))+'</div><div class="fine">Contact: '+(a().state.unlocks.includes(h.id)?'demo unlocked':'locked')+'</div><div class="lead-action"><a class="btn small" href="pitch.html?hotel='+encodeURIComponent(h.id)+'&campaign='+encodeURIComponent(cam.id)+'">Prepare pitch '+icon('arrow')+'</a></div></div>';
}
function campaignPreview(cam){
 const trip=a().tripById(cam.tripId), hotels=cam.hotelIds.map(findHotel).filter(Boolean);
 const sent=hotels.filter(h=>['sent','replied','won'].includes(stageValue(h.id))).length;
 const drafted=hotels.filter(h=>findDraft(h.id,cam.id)).length;
 return '<article class="campaign-row"><div><h3>'+html(cam.name)+'</h3><p>'+html(cam.city)+' · '+html(trip?trip.name:'Independent campaign')+'</p><div class="campaign-meta"><span class="badge">'+hotels.length+' hotels</span><span class="badge outlined">'+drafted+' drafts</span><span class="badge outlined">'+sent+' manual sends</span></div></div><div><div class="eyebrow">PROGRESS</div><div style="font-size:19px;font-weight:800;margin-top:5px">'+sent+' <span class="fine">/ '+hotels.length+'</span></div></div><div><button class="btn small wide" data-open-campaign="'+html(cam.id)+'">Open campaign '+icon('arrow')+'</button></div></article>';
}
function renderCampaigns(){
 const e=$('campaign-list');if(!e)return;
 const q=qs().get('campaign')||'';
 $('campaign-list').innerHTML=st.campaigns.length?st.campaigns.map(campaignPreview).join(''):'<div class="empty"><strong>No outreach campaigns yet</strong>Create a campaign from a destination or Trip, then add hotel leads and prepare individualized pitches.</div>';
 const area=$('campaign-open');if(!area)return;
 const selected=findCampaign(q)||(st.campaigns.length===1?st.campaigns[0]:null);
 if(!selected){area.innerHTML='<div class="flow-note">Choose a campaign above, or create your first one. Campaigns share the same hotels, Trips, drafts and activity as the rest of this demo.</div>';return}
 const available=a().H.filter(h=>(selected.city==='All destinations'||h.city===selected.city)&&!selected.hotelIds.includes(h.id));
 const leads=selected.hotelIds.map(findHotel).filter(Boolean);
 area.innerHTML='<div class="panel"><div class="panel-head"><div><div class="eyebrow">ACTIVE WORKSPACE</div><h2>'+html(selected.name)+'</h2><p>'+html(selected.city)+' · '+leads.length+' hotel leads · '+html(a().tripById(selected.tripId)?.name||'No linked Trip')+'</p></div><button class="btn small" data-campaign-add="'+html(selected.id)+'">'+icon('plus')+' Add hotels</button></div><div class="campaign-detail">'+(leads.length?leads.map(h=>actionLead(h,selected)).join(''):'<div class="empty"><strong>No hotels in this campaign</strong>Add hotels from Discover, an existing Trip, or the destination catalog.</div>')+'</div><div class="flow-note">This campaign uses real shared demo state. Pitch drafts and manual send logs will update these leads and your Pipeline. Gmail sending is not connected in this preview.</div></div>';
}
function campaignForm(){
 const opts=['Bangkok','Chiang Mai','Phuket','Ko Samui','Bali','Barcelona'].map(x=>'<option '+(a().state.city===x?'selected':'')+'>'+x+'</option>').join('');
 const trips=a().state.trips.map(t=>'<option value="'+html(t.id)+'">'+html(t.name)+' · '+html(t.city)+'</option>').join('');
 a().modal('Create outreach campaign','<p>Group target hotels in one destination and manage personalized pitches. Campaigns do not send bulk email.</p><form id="campaign-create"><div class="field" style="margin:12px 0"><label for="campaign-name">CAMPAIGN NAME</label><input id="campaign-name" required placeholder="e.g. Bangkok November Outreach"></div><div class="field" style="margin:12px 0"><label for="campaign-trip">LINK TO A TRIP (OPTIONAL)</label><select id="campaign-trip"><option value="">Independent campaign</option>'+trips+'</select></div><div class="field" style="margin:12px 0"><label for="campaign-city">DESTINATION</label><select id="campaign-city">'+opts+'</select></div><div class="fine" id="campaign-error">Existing trips and campaigns share the hotel catalog.</div><div class="modal-bottom"><button type="button" class="btn" data-close>Cancel</button><button class="btn lime" type="submit">Create campaign</button></div></form>');
}
function addHotelsModal(campaignId){
 const c=findCampaign(campaignId);if(!c)return;
 const saved=allSaved().filter(id=>!c.hotelIds.includes(id)).map(findHotel).filter(h=>h&&(c.city==='All destinations'||h.city===c.city));
 const other=a().H.filter(h=>(c.city==='All destinations'||h.city===c.city)&&!c.hotelIds.includes(h.id)&&!saved.includes(h));
 const choices=[...saved,...other];
 a().modal('Add hotels to '+html(c.name),'<p>Select example hotels. Saved hotels and Trip shortlists share IDs with this campaign.</p><form id="campaign-add-form" data-campaign="'+html(c.id)+'"><div style="max-height:300px;overflow:auto">'+(choices.length?choices.map(h=>'<label class="choice-card"><input name="hotel" type="checkbox" value="'+html(h.id)+'"><span><strong>'+html(h.name)+'</strong><small>'+html(h.city)+' · '+html(h.activity)+' creator activity</small></span></label>').join(''):'<div class="fine">Every available hotel is already part of this campaign.</div>')+'</div><div class="modal-bottom"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn lime">Add selected</button></div></form>');
}
function renderPitch(){
 if(!$('pitch-content'))return;
 const wanted=qs().get('hotel')||st.lastHotel||a().H[0].id;
 const h=findHotel(wanted)||a().H[0],campaignId=qs().get('campaign')||'';
 st.lastHotel=h.id;persist();
 const draft=findDraft(h.id,campaignId);
 const trip=a().state.trips.find(t=>(a().state.shortlists[t.id]||[]).includes(h.id)||(t.id===a().state.trip&&t.city===h.city));
 $('pitch-content').innerHTML='<div class="edit-split"><div><div class="panel"><div class="eyebrow">CREATE · REVISE · RESUME</div><div class="panel-head"><div><h2>Pitch for '+html(h.name)+'</h2><p>'+html(h.city)+' · '+html(h.type)+' · '+html(trip?trip.name:'No matching Trip selected')+'</p></div><a href="'+hotelLink(h.id)+'" class="btn small">Hotel detail</a></div><div class="field" style="margin-bottom:13px"><label for="pitch-strategy">OUTREACH STRATEGY</label><select id="pitch-strategy"><option value="content">Social-first UGC deliverables</option><option value="story">Luxury storytelling</option><option value="experience">Experience spotlight</option><option value="destination">Destination guide</option></select></div><div class="field" style="margin-bottom:13px"><label for="pitch-tone">VOICE</label><select id="pitch-tone"><option value="warm">Warm, professional</option><option value="direct">Concise, direct</option><option value="luxury">Editorial, premium</option></select></div><div class="field" style="margin-bottom:13px"><label for="pitch-subject">EMAIL SUBJECT</label><input id="pitch-subject" placeholder="Content collaboration idea for '+html(h.name)+'" maxlength="240"></div><div class="field"><label for="pitch-body">EMAIL BODY</label><textarea class="tall" id="pitch-body" placeholder="Write a personalized proposal. Avoid inventing audience figures, stay dates or deliverables."></textarea></div><div class="flow-note">Free: manual templates and copy. Pro/Max: Gmail + AI workflows in the actual product, only once configured and authorized. Nothing sends in this preview.</div><div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:18px"><button class="btn lime" data-pitch-save>Save draft</button><button class="btn" data-pitch-template>Insert starter template</button><button class="btn" data-pitch-copy>Copy email</button><button class="btn dark" data-pitch-log>Log as sent manually</button></div><div class="fine" style="margin-top:12px" id="pitch-status" aria-live="polite"></div></div></div><div><div class="panel"><div class="eyebrow">HOTEL CONTEXT</div><h2>'+html(h.name)+'</h2><p>'+html(h.city)+' · '+html(h.type)+'</p><div class="side-row"><span>Activity</span><b>'+html(h.activity)+'</b></div><div class="side-row"><span>Professional contact</span><b>'+(a().state.unlocks.includes(h.id)?'Demo unlocked':'Locked')+'</b></div><div class="side-row"><span>Campaign</span><b>'+html(findCampaign(campaignId)?.name||'None selected')+'</b></div><div class="side-row"><span>Draft</span><b>'+html(draft?'Saved':'Not saved')+'</b></div></div><div class="panel"><div class="eyebrow">DELIVERABILITY</div><h3>Protect your Gmail reputation</h3><p>Review every recipient and personalize each proposal. Sending volume should be paced, bounced contacts suppressed, and follow-ups stopped on reply or opt-out.</p><span class="badge success">Creator safety first</span></div><div class="panel"><div class="eyebrow">OTHER DRAFTS</div><div id="pitch-drafts">'+(st.drafts.length?st.drafts.slice().reverse().slice(0,6).map(d=>'<div class="draft-row"><div><strong>'+html(findHotel(d.hotelId)?.name||'Hotel')+'</strong><div class="fine">'+html(d.subject||'Untitled')+'</div></div><a class="btn small" href="pitch.html?hotel='+encodeURIComponent(d.hotelId)+'&campaign='+encodeURIComponent(d.campaignId||'')+'">Resume</a></div>').join(''):'<p>No saved drafts yet.</p>')+'</div></div></div></div>';
 if(draft){$('pitch-subject').value=draft.subject||'';$('pitch-body').value=draft.body||'';$('pitch-tone').value=draft.tone||'warm';$('pitch-strategy').value=draft.strategy||'content'}
}
function makeTemplate(){
 const h=findHotel(qs().get('hotel')||st.lastHotel)||a().H[0], t=a().state.trips.find(t=>(a().state.shortlists[t.id]||[]).includes(h.id)||t.id===a().state.trip);
 return {subject:'UGC collaboration idea for '+h.name,body:'Hello '+h.name+' team,\n\nI’m a travel content creator developing a new portfolio of social-first hospitality content'+(t?' around my upcoming trip to '+t.city+' ('+date(t.start)+'–'+date(t.end)+')':'')+'. I would love to explore whether a content collaboration could be useful for your property.\n\nI can share relevant previous work and discuss deliverables based on your needs. Would you be the right person to speak with, or could you point me to the partnerships team?\n\nThank you,\n[Your name]\n[Portfolio link]\n'};
}
function saveDraft(alsoLog){
 const id=qs().get('hotel')||st.lastHotel,h=findHotel(id);if(!h)return;
 const campaignId=qs().get('campaign')||'',body=inputValue('pitch-body'),subject=inputValue('pitch-subject');
 if(!body||!subject){$('pitch-status').textContent='Add a subject and body before saving.';return}
 let d=findDraft(h.id,campaignId);
 if(!d){d={id:newId('draft'),hotelId:h.id,campaignId};st.drafts.push(d)}
 Object.assign(d,{body,subject,tone:$('pitch-tone').value,strategy:$('pitch-strategy').value,updatedAt:new Date().toISOString()});
 if(!a().state.pipeline.includes(h.id))a().state.pipeline.push(h.id);
 if(campaignId){let c=findCampaign(campaignId);if(c&&!c.hotelIds.includes(h.id))c.hotelIds.push(h.id)}
 if(alsoLog){if(!st.events.some(e=>e.draftId===d.id&&e.type==='stage'&&e.value==='sent'))st.events.push({id:newId('event'),draftId:d.id,hotelId:h.id,campaignId,type:'stage',value:'sent',at:new Date().toISOString(),source:'manual'});$('pitch-status').textContent='Manual send recorded. This does NOT mean Gmail sent an email.';a().toast('Manual send logged in Inbox and Pipeline')}
 else{$('pitch-status').textContent='Draft saved. Your Pipeline and campaign now reference this hotel.';a().toast('Draft saved')}
 syncAll();if(alsoLog)renderPitch();
}
function renderPipeline(){
 const root=$('pipeline-view');if(!root)return;
 const ids=[...new Set([...a().state.pipeline,...st.events.map(e=>e.hotelId),...st.drafts.map(d=>d.hotelId)])];
 root.innerHTML=ids.length?ids.map(id=>{let h=findHotel(id);if(!h)return '';const draft=st.drafts.find(d=>d.hotelId===id),t=a().state.trips.find(t=>(a().state.shortlists[t.id]||[]).includes(id));
 return '<div class="campaign-lead"><div><a href="'+hotelLink(id)+'"><strong>'+html(h.name)+'</strong></a><div class="fine">'+html(h.city)+' · '+html(t?.name||'No trip')+'</div></div><div>'+badge(stageValue(id))+'</div><div class="fine">'+(draft?'Draft available':'No pitch draft')+'</div><div class="lead-action"><a class="btn small" href="pitch.html?hotel='+encodeURIComponent(id)+'">Open pitch '+icon('arrow')+'</a></div></div>'}).join(''):'<div class="empty"><strong>No pipeline activity yet</strong>Save a hotel in Discover or create a pitch to start tracking.</div>';
 $('pipeline-count').textContent=ids.length;
}
function renderInbox(){
 const root=$('inbox-view');if(!root)return;
 const sent=st.events.filter(e=>e.type==='stage'&&['sent','replied','won'].includes(e.value)).reverse();
 root.innerHTML=sent.length?sent.map(e=>{let h=findHotel(e.hotelId);return '<div class="campaign-lead"><div><strong>'+html(h?.name||'Hotel')+'</strong><div class="fine">'+html(new Date(e.at).toLocaleString())+' · '+html(e.source||'manual')+'</div></div><div>'+badge(e.value)+'</div><div class="fine">No Gmail sync in this preview</div><div class="lead-action"><a class="btn small" href="pitch.html?hotel='+encodeURIComponent(e.hotelId)+'">View draft</a></div></div>'}).join(''):'<div class="empty"><strong>No outreach events recorded</strong>Log a pitch as sent manually in Pitch Studio. Gmail messages do not sync to this design preview.</div>';
}
function renderTrips(){
 const root=$('trips-view');if(!root)return;
 root.innerHTML=a().state.trips.map(t=>{let arr=(a().state.shortlists[t.id]||[]).map(findHotel).filter(Boolean);return '<div class="panel"><div class="panel-head"><div><h2>'+html(t.name)+'</h2><p>'+html(t.city)+' · '+date(t.start)+' – '+date(t.end)+'</p></div><button class="btn small" data-use-trip="'+html(t.id)+'">Discover for this trip '+icon('arrow')+'</button></div><div class="campaign-detail">'+(arr.length?arr.map(h=>'<div class="campaign-lead"><div><a href="'+hotelLink(h.id)+'"><strong>'+html(h.name)+'</strong></a><div class="fine">'+html(h.city)+'</div></div><div>'+badge(stageValue(h.id))+'</div><div class="fine">Shortlisted</div><div class="lead-action"><a href="pitch.html?hotel='+encodeURIComponent(h.id)+'" class="btn small">Pitch</a></div></div>').join(''):'<div class="empty"><strong>No hotels shortlisted yet</strong>Use Discover to add hotels to this trip.</div>')+'</div></div>'}).join('')||'<div class="empty"><strong>No trips yet</strong>Create your first Trip from Discover.</div>';
}
function renderContracts(){
 let root=$('contract-documents');if(!root)return;
 root.innerHTML=st.contracts.length?st.contracts.slice().reverse().map(c=>'<div class="draft-row"><div><strong>'+html(c.title||'Untitled contract')+'</strong><div class="fine">Saved '+html(new Date(c.savedAt).toLocaleDateString())+' · '+c.content.length+' characters</div></div><button class="btn small" data-contract-load="'+html(c.id)+'">Open</button></div>').join(''):'<p>No contract excerpts saved yet. Paste contract text to review.</p>';
}
function contractHeuristics(text){
 const fields=[['Deliverables',/(deliverabl|content|video|photo|reel|post)/i,'Identify exactly what must be delivered, specifications, revision rounds and deadlines.'],
 ['Payment',/(pay|compensation|fee|amount|invoice|USD|EUR|€|\$)/i,'Confirm compensation, currency, payment trigger and payment date.'],
 ['Usage rights',/(usage|licen|copyright|intellectual property|perpetual|ownership)/i,'Review who can use the content, in which media, in what territories and for how long.'],
 ['Exclusivity',/(exclusiv|competing|non-compete)/i,'Check category restrictions, duration and geographic scope.'],
 ['Cancellation',/(cancel|terminat|refund|force majeure)/i,'Review cancellation rights, work already completed and reimbursement of costs.']];
 return fields.map(([name,re,note])=>{const match=re.exec(text),start=match?Math.max(0,match.index-55):0,end=match?Math.min(text.length,match.index+125):0;
 return '<div><strong>'+html(name)+'</strong><p>'+(match?'<span class="badge success">Keyword located</span><br><span style="display:block;margin-top:7px"><b>Source excerpt:</b> “'+html(text.slice(start,end).replace(/\s+/g,' ').trim())+'”</span>':'<span class="badge">Not located</span><br>No explicit reference was detected by the demo keyword scan.')+'</p><p>'+html(note)+'</p></div>'}).join('')
}
function contactEnhancement(){
 if(document.body.dataset.page!=='hotel')return;
 const h=a().state.currentHotel||a().H[0];if(!h)return;
 const premium=activePlan()!=='free';
 const cells=document.querySelectorAll('#hotel-metrics .metric-cell');
 [1,2].forEach(i=>{if(!premium&&cells[i]){const x=cells[i];if(!x.querySelector('.mini-upgrade'))x.insertAdjacentHTML('beforeend','<button class="mini-upgrade" data-upgrade>Unlock Pro '+icon('arrow')+'</button>')}});
 const c=$('contact-feature');if(c){
 const unlocked=a().state.unlocks.includes(h.id);
 c.innerHTML='<div class="side-contact-head"><div class="side-contact-icon">'+icon('user')+'</div><div><h3>'+ (unlocked?'Contact unlocked':'Meet the right hotel contact')+'</h3><p>'+ (unlocked?'Demo access enabled':'Reach the person or department handling creator partnerships')+'</p></div></div>'+
 (unlocked?'<div class="identity-skeleton"><div class="contact-tier">UNLOCKED IN THIS PROTOTYPE</div><p class="fine">No real name, email or title was retrieved. A production card would show verified fields when available.</p></div>':
 '<div class="identity-skeleton" aria-label="Schematic placeholder. No personal data hidden."><div class="identity-skeleton-top"><span class="identity-avatar">'+icon('user')+'</span><span class="mask-bars"><span class="mask-line w60"></span><span class="mask-line w85"></span></span></div><div class="mask-row"><span>Name and role</span><span class="mask-line"></span></div><div class="mask-row"><span>Professional email</span><span class="mask-line"></span></div><div class="mask-row"><span>Verification status</span><span class="mask-line"></span></div></div>')+
 '<div class="contact-panel-bottom">'+(unlocked?'<a class="btn lime" href="pitch.html?hotel='+encodeURIComponent(h.id)+'">Create personalized pitch '+icon('arrow')+'</a>':'<button class="btn lime" data-contact-unlock>Unlock hotel contacts · 1 credit '+icon('arrow')+'</button>')+'<p>1 credit per hotel upon successful unlock. Named contacts only when verified; otherwise show department or availability honestly.</p></div>';
 }
 if($('hotel-intelligence-upper'))$('hotel-intelligence-upper').classList.add('intelligence-first');
 if($('continue-pitch-btn'))$('continue-pitch-btn').href='pitch.html?hotel='+encodeURIComponent(h.id);
 if($('hotel-crumb-link'))$('hotel-crumb-link').href='discover.html';
}
function discoverEnhancement(){
 if(document.body.dataset.page!=='discover')return;
 const stt=a().state;
 if(!$('resume-explore'))return;
 const recent=st.recentSearch||{city:stt.city,search:stt.search,trip:stt.trip};
 $('resume-explore').innerHTML='<span>'+icon('search')+' <strong>Continue exploring '+html(recent.city||'your destinations')+'</strong> · <span>'+html(recent.search||'Your filters and selected Trip are remembered.')+'</span></span><button class="btn small" data-restore-search>Resume search '+icon('arrow')+'</button>';
 const box=$('saved-search-label');if(box)box.textContent=st.savedSearches.length?st.savedSearches.length+' saved':'Save this search';
}
function saveSearch(){
 const x=a().state;
 let entry={id:newId('search'),label:(x.city==='All destinations'?'Worldwide':x.city)+(x.type?' · '+x.type:''),city:x.city,search:x.search,type:x.type,activity:x.activity,sort:x.sort,trip:x.trip,collab:x.collab};
 st.savedSearches.unshift(entry);persist();a().toast('Search saved: '+entry.label);discoverEnhancement()
}
function savedSearchModal(){
 a().modal('Saved searches','<p>Restore destination, hotel type, activity and Trip context. These are saved locally in this design preview.</p><div>'+st.savedSearches.map(x=>'<div class="draft-row"><div><strong>'+html(x.label)+'</strong><div class="fine">'+html(x.search||'All matching hotels')+'</div></div><button class="btn small" data-search-restore="'+html(x.id)+'">Open</button></div>').join('')+'</div><div class="modal-bottom"><button class="btn lime" data-search-save>Save current search</button></div>');
}
function restoreSearch(x){
 if(!x)return;Object.assign(a().state,{city:x.city,search:x.search,type:x.type,activity:x.activity,sort:x.sort,trip:x.trip,collab:x.collab});a().saveState();a().closeModal();if(location.pathname.endsWith('discover.html')||location.pathname.endsWith('index.html')){a().render();discoverEnhancement();a().toast('Search restored')}else location.href='discover.html';
}
document.addEventListener('DOMContentLoaded',()=>{
 const page=document.body.dataset.page;
 if(page==='discover'){discoverEnhancement()}
 if(page==='hotel')contactEnhancement();
 if(page==='campaigns')renderCampaigns();
 if(page==='pitch')renderPitch();
 if(page==='pipeline')renderPipeline();
 if(page==='inbox')renderInbox();
 if(page==='trips')renderTrips();
 if(page==='contracts')renderContracts();
 document.querySelectorAll('[data-credit-count]').forEach(e=>e.textContent=activePlan()==='free'?'5':activePlan()==='pro'?'150':'500');
});
document.addEventListener('change',e=>{
 if(e.target.matches('[data-plan-select]'))setTimeout(()=>{contactEnhancement();if(document.body.dataset.page==='discover')discoverEnhancement()},0);
 if(e.target.id==='campaign-trip'){const t=a().tripById(e.target.value);if(t&&$('campaign-city'))$('campaign-city').value=t.city}
 if(['destination','filter-type','filter-activity','filter-collab','sort-by','trip-context'].includes(e.target.id)&&document.body.dataset.page==='discover'){st.recentSearch={city:a().state.city,search:a().state.search,trip:a().state.trip};persist()}
});
document.addEventListener('input',e=>{
 if(e.target.id==='search'&&document.body.dataset.page==='discover'){st.recentSearch={city:a().state.city,search:a().state.search,trip:a().state.trip};persist()}
});
document.addEventListener('click',e=>{
 if(e.target.closest('#confirm-unlock'))setTimeout(contactEnhancement,0);
 const b=e.target.closest('[data-v4],[data-campaign-add],[data-open-campaign],[data-pitch-save],[data-pitch-copy],[data-pitch-log],[data-pitch-template],[data-use-trip],[data-contract-load],[data-search-save],[data-search-restore],[data-restore-search],[data-saved-searches]');
 if(!b)return;
 if(b.dataset.v4==='new-campaign')campaignForm();
 if(b.dataset.campaignAdd)addHotelsModal(b.dataset.campaignAdd);
 if(b.dataset.openCampaign){history.replaceState({},'','campaigns.html?campaign='+encodeURIComponent(b.dataset.openCampaign));renderCampaigns();window.scrollTo({top:0,behavior:'smooth'})}
 if(b.dataset.pitchTemplate){const x=makeTemplate();$('pitch-subject').value=x.subject;$('pitch-body').value=x.body;a().toast('Starter template inserted; verify every detail')}
 if(b.dataset.pitchSave)saveDraft(false);
 if(b.dataset.pitchLog){const subject=inputValue('pitch-subject'),body=inputValue('pitch-body');if(!subject||!body){a().toast('Write a subject and message first');return}a().modal('Log an external send','<p>Use this only after you really sent a message outside the platform. Logging here does NOT send any email and must not be treated as verified network activity.</p><div class="modal-bottom"><button class="btn" data-close>Cancel</button><button class="btn lime" data-v4="confirm-manual-send">Log sent manually</button></div>')}
 if(b.dataset.v4==='confirm-manual-send'){a().closeModal();saveDraft(true)}
 if(b.dataset.pitchCopy){const data=inputValue('pitch-subject')+'\n\n'+inputValue('pitch-body');if(!inputValue('pitch-body'))return a().toast('No email body to copy');navigator.clipboard?.writeText(data).then(()=>a().toast('Email copied')).catch(()=>a().toast('Clipboard unavailable')); }
 if(b.dataset.useTrip){a().state.trip=b.dataset.useTrip;const t=a().tripById(b.dataset.useTrip);if(t)a().state.city=t.city;a().saveState();location.href='discover.html'}
 if(b.dataset.contractLoad){const c=st.contracts.find(x=>x.id===b.dataset.contractLoad);if(c){$('contract-title').value=c.title;$('contract-text').value=c.content;$('contract-notes').innerHTML=contractHeuristics(c.content);a().toast('Saved excerpt loaded')}}
 if(b.dataset.searchSave)saveSearch();
 if(b.hasAttribute('data-saved-searches'))savedSearchModal();
 if(b.dataset.searchRestore)restoreSearch(st.savedSearches.find(x=>x.id===b.dataset.searchRestore));
 if(b.hasAttribute('data-restore-search')){a().render();discoverEnhancement();a().toast('Search context restored')}
 if(b.dataset.v4==='contract-review'){let text=inputValue('contract-text');if(!text){a().toast('Paste a contract excerpt first');return}if(text.length<25){a().toast('Add a longer excerpt so there is text to review');return}
 $('contract-notes').innerHTML=contractHeuristics(text);a().toast('Checklist generated from text keywords; not an AI or legal review')}
 if(b.dataset.v4==='contract-save'){let text=inputValue('contract-text');if(!text)return a().toast('Paste contract text first');st.contracts.push({id:newId('contract'),title:inputValue('contract-title')||'Untitled excerpt',content:text,savedAt:new Date().toISOString()});persist();renderContracts();a().toast('Contract excerpt saved locally')}
 if(b.dataset.v4==='campaign-from-trip'){location.href='campaigns.html'}
});
document.addEventListener('submit',e=>{
 if(e.target.id==='campaign-create'){
  e.preventDefault();let name=inputValue('campaign-name'),tripId=$('campaign-trip').value,t=a().tripById(tripId),city=t?t.city:$('campaign-city').value;
  if(!name)return;
  const id=newId('campaign'),hotelIds=t?[...(a().state.shortlists[t.id]||[])]:[];
  st.campaigns.push({id,name,tripId,city,hotelIds,createdAt:new Date().toISOString()});persist();a().closeModal();history.replaceState({},'','campaigns.html?campaign='+encodeURIComponent(id));renderCampaigns();a().toast('Campaign created');
 }
 if(e.target.id==='campaign-add-form'){
  e.preventDefault();let cam=findCampaign(e.target.dataset.campaign);if(!cam)return;
  [...e.target.querySelectorAll('input[name=hotel]:checked')].forEach(input=>{if(!cam.hotelIds.includes(input.value))cam.hotelIds.push(input.value)});
  persist();a().closeModal();renderCampaigns();a().toast('Hotels added to campaign');
 }
});
})();