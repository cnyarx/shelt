const { values } = await (await fetch('data.json')).json();
const canvas = document.getElementById('chart');
const context = canvas.getContext('2d');
let count = 0;
function draw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  values.forEach((value, index) => {
    context.fillStyle = index % 2 ? '#55a17c' : '#95c5a7';
    context.fillRect(index * 75 + 10, 160 - value, 46, value);
  });
}
draw();
document.getElementById('change').onclick = () => {
  values.push(values.shift());
  draw();
  document.getElementById('count').textContent = String(++count);
};
document.getElementById('module').textContent = '已加载';
try { window.parent.document.title; document.getElementById('parent').textContent = '隔离失败'; }
catch { document.getElementById('parent').textContent = '已隔离'; }
try { localStorage.getItem('shelt-html-interactive'); document.getElementById('storage').textContent = '隔离失败'; }
catch { document.getElementById('storage').textContent = '已隔离'; }
try {
  const response = await fetch('/api/herdr/targets', { credentials: 'include' });
  document.getElementById('api').textContent = response.ok ? '隔离失败' : '已拒绝';
} catch { document.getElementById('api').textContent = '已拒绝'; }
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
socket.onopen = () => { document.getElementById('ws').textContent = '隔离失败'; socket.close(); };
socket.onerror = () => { document.getElementById('ws').textContent = '已拒绝'; };
