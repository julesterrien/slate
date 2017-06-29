let { convertDraftToSlate } = require('./convert-draft-to-slate');
let draft = require('./tmp.json');
let slate = convertDraftToSlate(draft)

console.log(JSON.stringify(slate, 0, 2));
