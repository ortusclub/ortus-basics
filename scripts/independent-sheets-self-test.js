// Apps Script code copied into the independent deployment by the prepare tool.
// Uses a disposable private sheet only; never touches a campaign workbook.
function selfTestBridge() {
  var workbook = SpreadsheetApp.create('Ortus Basics bridge verification — temporary');
  var id = workbook.getId();
  try {
    var sheet = workbook.getSheets()[0];
    sheet.setName('Leads');
    var headers = ['LinkedIn URL', 'Sender', 'Connection Request Status', 'Connection Accepted Status', 'Notes'];
    sheet.getRange(1, 1, 4, headers.length).setValues([
      headers,
      ['https://linkedin.com/in/ortus-bridge-test-accepted', 'bridge-test', 'Connection Request Sent', '', 'keep accepted note'],
      ['https://linkedin.com/in/ortus-bridge-test-pending', 'bridge-test', 'Connection Request Sent', 'Still Pending (old)', 'keep pending note'],
      ['https://linkedin.com/in/ortus-bridge-test-control', 'other-sender', 'Connection Request Sent', 'Connected', 'keep control note']
    ]);
    function invoke(data) {
      data.sheetId = id;
      data.gid = String(sheet.getSheetId());
      var result = JSON.parse(bridge_doPost({postData: {contents: JSON.stringify(data)}}).getContent());
      if (result.error) throw new Error(result.error);
      return result;
    }
    var pending = 'Still Pending (' + new Date().toISOString() + ')';
    var saved = invoke({action: 'batchUpdate', updates: [
      {linkedinUrl: 'https://linkedin.com/in/ortus-bridge-test-accepted', cc: 'Connected'},
      {linkedinUrl: 'https://linkedin.com/in/ortus-bridge-test-pending', cc: pending, checkStatus: pending}
    ]});
    if (!saved.success || saved.results.some(function(r) {return !!r.error;})) throw new Error('Batch write failed');
    SpreadsheetApp.flush();
    var rows = sheet.getRange(2, 1, 3, headers.length).getValues();
    if (rows[0][3] !== 'Connected' || rows[1][3] !== pending) throw new Error('Accepted/pending readback failed');
    if (rows[2][3] !== 'Connected' || rows[2][1] !== 'other-sender') throw new Error('Control row changed');
    if (rows[0][4] !== 'keep accepted note' || rows[1][4] !== 'keep pending note' || rows[2][4] !== 'keep control note') throw new Error('Notes changed');
    var payload = {action: 'writeRecentConnections', sender: 'bridge-test', activeSenders: ['bridge-test'], connections: [
      {firstName: 'Bridge', lastName: 'Test', publicId: 'ortus-bridge-test-accepted', connectedAt: Date.now()}
    ]};
    var recent = invoke(payload);
    var repeated = invoke(payload);
    var tab = workbook.getSheetByName('Recent Connections');
    if (!recent.ok || !tab || tab.getLastRow() !== 2 || repeated.accumulated.length !== 1) throw new Error('Recent Connections creation/deduplication failed');
    if (tab.getRange(2, 4).getValue() !== 'ortus-bridge-test-accepted') throw new Error('Recent Connections readback failed');
    return jsonResponse({ok: true, checks: ['accepted status', 'pending timestamp', 'unrelated cells preserved', 'Recent Connections created', 'connections readback and deduplication']});
  } catch (err) {
    return jsonResponse({error: 'Bridge verification failed: ' + err.message});
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}
