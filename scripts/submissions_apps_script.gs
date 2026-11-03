/**
 * WISE map — data submission receiver (Google Apps Script)
 *
 * Receives submissions from the "Is your site missing?" form on
 * https://jaimiechun.github.io/lib-map-v2/ and appends each one as a row in
 * this spreadsheet, then emails NOTIFY_EMAIL so nothing waits unseen.
 *
 * Deploy: Deploy > New deployment > type "Web app",
 *   Execute as:      Me
 *   Who has access:  Anyone
 * Copy the /exec URL it gives you — that becomes SUBMIT_ENDPOINT in app.js.
 * Re-deploy ("Manage deployments" > edit > Version: New version) after any
 * edit here, or the live site keeps running the old code.
 */

// Who gets told about a new submission. Blank disables the email.
var NOTIFY_EMAIL = 'sera.young@northwestern.edu';

// Sheet tab to write to; created automatically if missing.
var SHEET_NAME = 'Submissions';

// Column order. The first two are added by this script; the rest are the
// form's own field names, so adding a field to the form means adding its
// name here. The last two are blank for the review workflow.
var COLUMNS = [
  ['Received',       null],
  ['Reviewed?',      null],
  ['Added to map?',  null],
  ['Country',        'country'],
  ['Location',       'location'],
  ['Data level',     'level'],
  ['Status',         'status'],
  ['Tool',           'tool'],
  ['Collection dates', 'dates'],
  ['Source / survey', 'source'],
  ['Link',           'link'],
  ['Data contact',   'contact'],
  ['Submitted by',   'submitter'],
  ['Notes',          'notes']
];

function doPost(e) {
  try {
    var data = parseBody(e);
    var sheet = getSheet();
    sheet.appendRow(buildRow(data));
    notify(data);
    return json({ ok: true });
  } catch (err) {
    // Logged to Executions in the Apps Script editor, so a failed submission
    // can be traced rather than vanishing.
    console.error(err);
    return json({ ok: false, error: String(err) });
  }
}

/** Lets you open the /exec URL in a browser to check the deployment is live. */
function doGet() {
  return json({ ok: true, message: 'WISE submissions endpoint is running.' });
}

/**
 * The form posts JSON as text/plain — a "simple" request, which avoids the
 * CORS preflight that Apps Script web apps cannot answer. Form-encoded posts
 * are handled too, so testing from curl or a plain HTML form still works.
 */
function parseBody(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (ignored) {
      // fall through to the parameter form below
    }
  }
  return (e && e.parameter) || {};
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    var headers = COLUMNS.map(function (c) { return c[0]; });
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function buildRow(data) {
  return COLUMNS.map(function (col) {
    var field = col[1];
    if (col[0] === 'Received') return new Date();
    if (!field) return '';            // review columns, filled in by hand
    return data[field] || '';
  });
}

function notify(data) {
  if (!NOTIFY_EMAIL) return;
  var lines = COLUMNS
    .filter(function (c) { return c[1]; })
    .map(function (c) { return c[0] + ': ' + (data[c[1]] || '-'); });
  lines.push('', 'Spreadsheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl());

  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: 'WISE map data submission: ' + (data.country || 'unknown country'),
    body: lines.join('\n'),
    replyTo: extractEmail(data.submitter) || undefined
  });
}

function extractEmail(text) {
  var match = String(text || '').match(/[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/);
  return match ? match[0] : '';
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to check the sheet and email both work. */
function testSubmission() {
  doPost({
    postData: {
      contents: JSON.stringify({
        country: 'Test Country',
        location: 'Test City',
        level: 'Site',
        status: 'Completed',
        tool: 'HWISE-12',
        dates: 'January 2026',
        source: '',
        link: 'https://example.org',
        contact: 'contact@example.org',
        submitter: 'Test Person, test@example.org',
        notes: 'This is a test row — delete it.'
      })
    }
  });
}
