// Fixture site 3 — interactive widgets: modal + dropdown menu + tabs + a form
// with client-side validation, all on one page.
//
// Design notes (matched to the engine's interaction explorer):
//  - The modal uses class "modal" and is fixed-positioned ≥80x40 px, so
//    locateOverlay() (src/interactions.js) finds it as an overlay state.
//  - The dropdown trigger uses class "dropdown-trigger" (top explorer priority)
//    and opens a "dropdown-menu" with 5 <li> menu items ≥40x25 px, so the
//    overlay has the ≥5 entries that send the explorer into deep capture.
//  - Tabs are [role="tab"] buttons swapping panes; the form's controls sit
//    inside <form> so the explorer deliberately never clicks them, and no
//    control text matches the engine's dangerous-word filter.
import { sendHtml, reqUrl } from "./server.mjs";

const html = `<!DOCTYPE html><html><head><title>Orbit Dashboard — widgets</title><style>
body{font-family:Verdana,Arial,sans-serif;margin:0;color:#222;background:#f2f4f8}
main{max-width:720px;margin:30px auto;padding:22px;background:#fff;border:1px solid #ccd}
h1{font-size:24px;margin:0 0 16px}
.dropdown-wrap{position:relative;display:inline-block}
.dropdown-trigger{padding:10px 16px;font-size:15px}
.dropdown-menu{display:none;position:absolute;top:100%;left:0;width:260px;background:#fff;border:1px solid #778;z-index:40;margin:4px 0 0;padding:6px 0;list-style:none}
.dropdown-menu li{padding:10px 12px;min-height:25px;border-bottom:1px solid #e3e3e3;cursor:pointer}
.dropdown-menu li:hover{background:#eef}
#selection-note{color:#555}
.tab-row{margin:26px 0 0}
.tab-btn{padding:9px 20px;margin-right:6px;font-size:15px}
.tab-pane{border:1px solid #ccd;padding:14px;margin-top:10px;min-height:70px}
.action-btn{margin:26px 0 8px;padding:10px 16px;font-size:15px}
.modal{display:none;position:fixed;top:90px;left:50%;transform:translateX(-50%);width:420px;min-height:260px;background:#fff;border:2px solid #556;z-index:50;padding:18px}
.modal h2{margin-top:0}
.modal label{display:block;margin:8px 0}
.dismiss-btn{margin-top:14px;padding:8px 14px}
form{margin-top:26px;border:1px solid #ccd;padding:16px;background:#fafafa}
form label{display:block;margin:10px 0}
form input[type=text],form input[type=email]{padding:7px;border:1px solid #99a;width:240px}
.form-note{min-height:20px;font-size:14px}
</style></head><body>
<main>
<h1>Orbit Dashboard</h1>
<div class="dropdown-wrap">
  <button class="dropdown-trigger" title="Options menu">Show options menu</button>
  <ul class="dropdown-menu" id="options-menu">
    <li class="menu-item">Sort by name</li>
    <li class="menu-item">Sort by date</li>
    <li class="menu-item">Filter active</li>
    <li class="menu-item">Group by type</li>
    <li class="menu-item">Expand sections</li>
  </ul>
</div>
<p id="selection-note">No option selected yet.</p>
<div class="tab-row" role="tablist">
  <button role="tab" class="tab-btn" data-pane="overview">Overview</button>
  <button role="tab" class="tab-btn" data-pane="activity">Activity</button>
</div>
<div class="tab-pane" id="pane-overview"><p>Overview pane — uptime, traffic and usage summary for the workspace.</p></div>
<div class="tab-pane" id="pane-activity" style="display:none"><p>Activity pane — 128 events recorded in the last seven days.</p></div>
<button class="action-btn" id="open-prefs">Open preferences</button>
<div class="modal" id="prefs-modal">
  <h2>Preferences panel</h2>
  <p>Choose how Orbit Dashboard highlights overdue items and escalation rules.</p>
  <label><input type="checkbox"> Highlight overdue rows</label>
  <label><input type="checkbox"> Play notification sounds</label>
  <button class="dismiss-btn" onclick="document.getElementById('prefs-modal').style.display='none'">Dismiss panel</button>
</div>
<form id="profile-form">
  <h2>Profile details</h2>
  <label>Display name <input type="text" name="displayname" placeholder="Ada Lovelace"></label>
  <label>Work email <input type="email" name="email" placeholder="ada@example.com"></label>
  <label><input type="checkbox" name="digest"> Weekly digest</label>
  <button type="button" class="save-btn" onclick="saveProfile()">Save details</button>
  <p class="form-note" id="form-note"></p>
</form>
</main>
<script>
function saveProfile() {
  var email = document.querySelector('#profile-form input[name="email"]');
  var note = document.getElementById('form-note');
  if (!email.value || email.value.indexOf('@') < 0) {
    note.textContent = 'Validation failed: enter a valid work email address.';
    note.style.color = '#b00020';
  } else {
    note.textContent = 'Profile details saved.';
    note.style.color = '#0a7d33';
  }
}
var paneBtns = document.querySelectorAll('.tab-btn');
for (var i = 0; i < paneBtns.length; i++) {
  paneBtns[i].addEventListener('click', function (e) {
    var name = e.currentTarget.getAttribute('data-pane');
    var panes = document.querySelectorAll('.tab-pane');
    for (var k = 0; k < panes.length; k++) panes[k].style.display = 'none';
    document.getElementById('pane-' + name).style.display = 'block';
  });
}
document.getElementById('open-prefs').addEventListener('click', function () {
  document.getElementById('prefs-modal').style.display = 'block';
});
var trigger = document.querySelector('.dropdown-trigger');
var menu = document.getElementById('options-menu');
trigger.addEventListener('click', function () {
  menu.style.display = (menu.style.display === 'block') ? 'none' : 'block';
});
var items = document.querySelectorAll('.menu-item');
for (var m = 0; m < items.length; m++) {
  items[m].addEventListener('click', function (e) {
    document.getElementById('selection-note').textContent = 'Selected option: ' + e.currentTarget.textContent;
  });
}
</script></body></html>`;

export const widgetsSite = {
  name: "widgets",
  entry: "/",
  handle(req, res) {
    if (reqUrl(req).pathname === "/") {
      sendHtml(res, html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("fixture: not found");
  },
};
