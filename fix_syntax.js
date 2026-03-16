const fs = require('fs');
['api.js', 'main.js', 'ui.js'].forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    content = content.split('\\`').join('`');
    content = content.split('\\${').join('${');
    fs.writeFileSync(file, content);
});
console.log('Fixed syntax escapes');
