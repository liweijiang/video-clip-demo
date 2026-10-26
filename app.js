const $ = id => document.getElementById(id);
const video = $('video');
let start = 0, end = 0, sourceURL, outputURL, fileName, previewing = false, exporting = false, generation = 0;
let sourceFile, cancelExport;
const hosted = !['localhost', '127.0.0.1'].includes(location.hostname);
const format = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const status = message => $('status').textContent = message;
function invalidateDownload() {
  $('download').hidden = true;
  if (outputURL) { URL.revokeObjectURL(outputURL); outputURL = null; }
}
function commitTimes() {
  const a = $('start').valueAsNumber, b = $('end').valueAsNumber;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > video.duration + .005) {
    status('Enter valid Start and End times within the video duration.');
    return false;
  }
  start = a; end = Math.min(b, video.duration);
  update();
  return true;
}
function update() {
  const duration = video.duration;
  if (!Number.isFinite(duration) || !duration) return;
  $('start').value = start.toFixed(2); $('end').value = end.toFixed(2);
  $('duration').textContent = format(end - start);
  invalidateDownload();
  $('selection').style.left = `${start / duration * 100}%`;
  $('selection').style.width = `${(end - start) / duration * 100}%`;
  $('shade-left').style.width = `${start / duration * 100}%`;
  $('shade-right').style.width = `${(duration - end) / duration * 100}%`;
  for (const [name, value] of [['start', start], ['end', end]]) {
    const handle = $(`handle-${name}`);
    handle.style.left = `${value / duration * 100}%`;
    handle.setAttribute('aria-valuenow', value.toFixed(2));
    handle.setAttribute('aria-valuemax', duration);
    handle.setAttribute('aria-valuetext', format(value));
    $(name).max = duration;
  }
}
function change(which, value) {
  if (exporting || !Number.isFinite(value)) return;
  previewing = false; video.pause();
  const minimum = Math.min(.1, video.duration);
  if (which === 'start') start = Math.max(0, Math.min(value, end - minimum));
  else end = Math.min(video.duration, Math.max(value, start + minimum));
  video.currentTime = which === 'start' ? start : end;
  update();
}
async function load(file) {
  if (!file || exporting) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v|ogg)$/i.test(file.name)) return status('Choose a video file to get started.');
  generation++; previewing = false; video.pause();
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  if (outputURL) URL.revokeObjectURL(outputURL);
  $('download').hidden = true; $('editor').hidden = true;
  sourceFile = file; sourceURL = URL.createObjectURL(file); fileName = file.name;
  video.src = sourceURL; video.load(); status('Opening your video…');
}
video.addEventListener('loadedmetadata', () => {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return status('This video has no readable duration. Try an MP4 or WebM file.');
  start = 0; end = video.duration; resetCrop();
  $('filename').textContent = fileName;
  $('dimensions').textContent = `${video.videoWidth} × ${video.videoHeight} · ${format(end)}`;
  $('dropzone').hidden = true; $('editor').hidden = false;
  $('ruler').replaceChildren(...Array.from({length: 6}, (_, i) => {const el = document.createElement('span'); el.textContent = format(end * i / 5); return el;}));
  update(); status('Ready. Drag the green handles to find your moment.'); thumbnails(sourceURL, generation);
});
video.addEventListener('error', () => {status('Your browser could not read this video. Try a different MP4 or WebM file.'); $('dropzone').hidden = false; $('editor').hidden = true;});
$('file').onchange = event => {load(event.target.files[0]); event.target.value = '';};
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, event => {event.preventDefault(); $('dropzone').classList.add('over');});
$('dropzone').ondragleave = () => $('dropzone').classList.remove('over');
$('dropzone').ondrop = event => {event.preventDefault(); $('dropzone').classList.remove('over'); load(event.dataTransfer.files[0]);};
for (const which of ['start', 'end']) {
  $(which).oninput = () => {
    invalidateDownload();
    const a = $('start').valueAsNumber, b = $('end').valueAsNumber;
    $('duration').textContent = Number.isFinite(a) && Number.isFinite(b) && b > a ? format(b-a) : '—';
  };
  $(which).onchange = event => {change(which, event.target.valueAsNumber); update();};
  const handle = $(`handle-${which}`);
  handle.onpointerdown = event => {if (exporting) return; event.preventDefault(); handle.setPointerCapture(event.pointerId);};
  handle.onpointermove = event => {if (handle.hasPointerCapture(event.pointerId)) change(which, position(event));};
  handle.onpointerup = event => {if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);};
  handle.onkeydown = event => {if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault(); change(which, (which === 'start' ? start : end) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .1));}};
}
function position(event) {const bounds = $('timeline').getBoundingClientRect(); return Math.max(0, Math.min(video.duration, (event.clientX - bounds.left) / bounds.width * video.duration));}
$('timeline').onpointerdown = event => {if (!exporting && !event.target.closest('.handle')) {previewing = false; video.currentTime = position(event);}};
$('reset').onclick = () => {start = 0; end = video.duration; previewing = false; video.pause(); video.currentTime = 0; update();};
$('preview').onclick = async () => {if (!commitTimes()) return; try {video.pause(); await seek(video, start); previewing = true; await video.play();} catch {status('Playback could not start. Try the video play button.');}};
video.addEventListener('timeupdate', () => { $('playhead').style.left = `${video.currentTime / video.duration * 100}%`; if (previewing && video.currentTime >= end) {video.pause(); previewing = false; video.currentTime = end;}});
function seek(element, time) {
  if (Math.abs(element.currentTime - time) < .001 && element.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {cleanup(); reject(new Error('Video seek timed out.'));}, 15000);
    const done = () => {cleanup(); resolve();};
    const cleanup = () => {clearTimeout(timer); element.removeEventListener('seeked', done);};
    element.addEventListener('seeked', done); element.currentTime = time;
  });
}
async function thumbnails(url, token) {
  $('filmstrip').replaceChildren();
  const probe = document.createElement('video'); probe.muted = true; probe.preload = 'auto'; probe.src = url;
  try {
    await new Promise((resolve, reject) => {probe.onloadeddata = resolve; probe.onerror = reject;});
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 100;
    for (let i = 0; i < 8 && token === generation; i++) {
      await seek(probe, Math.min(probe.duration * (i + .5) / 8, probe.duration - .01));
      canvas.getContext('2d').drawImage(probe, 0, 0, 180, 100);
      const image = new Image(); image.alt = ''; image.src = canvas.toDataURL('image/jpeg', .65);
      if (token === generation) $('filmstrip').append(image);
    }
  } catch { /* The timeline remains usable if thumbnail decoding fails. */ }
  finally {probe.removeAttribute('src'); probe.load();}
}
function lock(value) {
  exporting = value; video.controls = !value && !$('crop-enabled').checked;
  for (const id of ['start','end','preview','export','reset','file','handle-start','handle-end','output-name','trim-mode']) $(id).disabled = value;
  for (const el of document.querySelectorAll('.crop-tools input, .crop-tools button')) el.disabled = value;
  $('crop-overlay').style.pointerEvents = value ? 'none' : '';
  $('trim-mode').disabled = value || $('crop-enabled').checked;
  $('progress').hidden = !value; $('cancel').hidden = !value;
}
$('cancel').onclick = () => cancelExport?.();

function recordingType() {
  const types = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function browserExport(selection, outputName, controller) {
  const capture = video.captureStream || video.mozCaptureStream;
  if (!window.MediaRecorder || !capture) {
    throw new Error('This browser cannot export video locally. Try the latest Chrome or Edge.');
  }
  const type = recordingType();
  if (!type) throw new Error('This browser does not provide a supported video recorder.');

  await seek(video, selection.start);
  const sourceStream = capture.call(video);
  let stream = sourceStream;
  let animation;
  if (selection.crop) {
    const [x, y, w, h] = selection.crop;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.floor(video.videoWidth * w / 2) * 2);
    canvas.height = Math.max(2, Math.floor(video.videoHeight * h / 2) * 2);
    const context = canvas.getContext('2d', {alpha: false});
    const draw = () => {
      context.drawImage(video,
        video.videoWidth * x, video.videoHeight * y,
        video.videoWidth * w, video.videoHeight * h,
        0, 0, canvas.width, canvas.height);
      animation = requestAnimationFrame(draw);
    };
    draw();
    stream = canvas.captureStream(30);
    for (const track of sourceStream.getAudioTracks()) stream.addTrack(track);
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, {mimeType: type, videoBitsPerSecond: 8_000_000});
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = () => reject(recorder.error || new Error('Browser recording failed.'));
  });
  const finish = () => {
    if (recorder.state !== 'inactive') recorder.stop();
    video.pause();
  };
  const timer = setInterval(() => {
    $('progress').value = Math.max(0, Math.min(1, (video.currentTime - selection.start) / (selection.end - selection.start)));
    if (video.currentTime >= selection.end || video.ended) finish();
  }, 50);
  const abort = () => finish();
  controller.signal.addEventListener('abort', abort, {once: true});

  try {
    video.muted = true;
    recorder.start(250);
    await video.play();
    await stopped;
    if (controller.signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    const blob = new Blob(chunks, {type});
    if (!blob.size) throw new Error('The browser did not produce a clip.');
    const extension = type.startsWith('video/mp4') ? '.mp4' : '.webm';
    return {blob, name: outputName.replace(/\.mp4$/i, extension)};
  } finally {
    clearInterval(timer);
    cancelAnimationFrame(animation);
    controller.signal.removeEventListener('abort', abort);
    video.muted = false;
    for (const track of stream.getTracks()) track.stop();
    for (const track of sourceStream.getTracks()) track.stop();
  }
}

$('export').onclick = async () => {
  if (!sourceFile || exporting) return;
  if (!commitTimes()) return;
  const selection = {start, end, mode: $('trim-mode').value, crop: $('crop-enabled').checked ? [...crop] : null};
  if (!['http:', 'https:'].includes(location.protocol)) return status('Open http://localhost:8000 to use local, original-quality export.');
  const outputName = $('output-name').value;
  const controller = new AbortController();
  const id = crypto.randomUUID();
  cancelExport = () => {
    controller.abort();
    if (!hosted) fetch(`/api/cancel?id=${id}`, {method: 'POST', headers: {'X-Cutroom-Export': '1'}}).catch(() => {});
  };
  lock(true); previewing = false; video.pause(); $('download').hidden = true;
  $('progress').removeAttribute('value');
  status(`Exporting ${format(selection.start)}–${format(selection.end)} (${format(selection.end-selection.start)})… ` + ($('crop-enabled').checked ? 'Cropping and encoding your video locally…' : $('trim-mode').value === 'precise' ? 'Encoding your selected time range locally…' : 'Copying original video and audio with local FFmpeg…'));
  try {
    if (hosted) {
      const result = await browserExport(selection, outputName, controller);
      if (outputURL) URL.revokeObjectURL(outputURL);
      outputURL = URL.createObjectURL(result.blob);
      const link = $('download'); link.href = outputURL; link.download = result.name; link.hidden = false; link.click();
      status(`${result.name} is ready. It was encoded privately in your browser; the video was never uploaded.`);
      return;
    }
    const health = await fetch('/api/health', {signal: controller.signal});
    if (!health.ok || !(await health.json()).ready) throw new Error('Start the FFmpeg server with: python3 server.py');
    const params = new URLSearchParams({id, start: selection.start, end: selection.end, name: outputName, mode: selection.mode});
    if (selection.crop) params.set('crop', JSON.stringify(selection.crop));
    const response = await fetch(`/api/export?${params}`, {
      method: 'POST', headers: {'Content-Type': 'application/octet-stream', 'X-Cutroom-Export': '1'},
      body: sourceFile, signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Local export failed.');
    }
    const blob = await response.blob();
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = URL.createObjectURL(blob);
    const link = $('download'); link.href = outputURL; link.download = outputName; link.hidden = false; link.click();
    status($('crop-enabled').checked ? `${outputName} is ready: ${format(selection.start)}–${format(selection.end)} (${format(selection.end-selection.start)}), cropped.` : $('trim-mode').value === 'precise' ? `${outputName} is ready: ${format(selection.start)}–${format(selection.end)} (${format(selection.end-selection.start)}).` : `${outputName} is ready at original quality. The cut may start earlier at the preceding keyframe; the end aligns to media packets.`);
  } catch (error) {
    status(error.name === 'AbortError' ? 'Export cancelled. Your selection is still ready.' : `Export failed: ${error.message}`);
  } finally {cancelExport = null; lock(false);}
};

// Crop coordinates are fractions of the displayed (rotation-corrected) frame.
let crop = [0, 0, 1, 1], cropAnchor;
const cropKeys = ['x', 'y', 'w', 'h'];
function resetCrop() { crop = [0, 0, 1, 1]; renderCrop(); }
function renderCrop() {
  const enabled = $('crop-enabled').checked;
  $('crop-overlay').hidden = !enabled;
  $('trim-mode').disabled = enabled || exporting;
  video.controls = !enabled && !exporting;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const w = video.videoWidth * scale, h = video.videoHeight * scale;
  if (Number.isFinite(w) && Number.isFinite(h)) Object.assign($('crop-overlay').style, {
    left: `${video.offsetLeft + (rect.width - w) / 2}px`, top: `${video.offsetTop + (rect.height - h) / 2}px`, width: `${w}px`, height: `${h}px`
  });
  Object.assign($('crop-box').style, {left: `${crop[0]*100}%`, top: `${crop[1]*100}%`, width: `${crop[2]*100}%`, height: `${crop[3]*100}%`});
  cropKeys.forEach((key, i) => { $('crop-' + key).value = +(crop[i]*100).toFixed(2); });
  $('crop-size').textContent = enabled ? `${Math.floor(video.videoWidth*crop[2]/2)*2} × ${Math.floor(video.videoHeight*crop[3]/2)*2} pixels` : 'Full frame';
  $('export-note').textContent = hosted ? 'Private browser export · your source video stays on this device. MP4 is used when supported; otherwise the clip downloads as WebM.' : enabled ? 'Cropping uses precise time trimming and high-quality H.264/AAC encoding. Output dimensions round down to even pixels.' : $('trim-mode').value === 'precise' ? 'Precise trimming matches the selected times to video frames. Video and audio are re-encoded at high quality.' : 'Original quality · no re-encoding. Lossless cuts may start earlier at the preceding keyframe; the end aligns to media packets.';
}
$('trim-mode').onchange = renderCrop;
$('crop-enabled').onchange = () => { video.pause(); previewing = false; renderCrop(); };
$('crop-reset').onclick = resetCrop;
cropKeys.forEach((key, i) => { $('crop-' + key).onchange = event => {
  const value = event.target.valueAsNumber / 100;
  if (Number.isFinite(value)) {
    const minW = Math.min(1, 2 / video.videoWidth), minH = Math.min(1, 2 / video.videoHeight);
    crop[i] = Math.max(i === 2 ? minW : i === 3 ? minH : 0, Math.min(1, value));
    crop[0] = Math.min(crop[0], 1-minW); crop[1] = Math.min(crop[1], 1-minH);
    crop[2] = Math.min(crop[2], 1-crop[0]); crop[3] = Math.min(crop[3], 1-crop[1]);
  }
  renderCrop();
}; });
function cropPoint(event) {
  const rect = $('crop-overlay').getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX-rect.left)/rect.width)), Math.max(0, Math.min(1, (event.clientY-rect.top)/rect.height))];
}
$('crop-overlay').onpointerdown = event => {
  if (exporting) return;
  video.pause(); previewing = false; cropAnchor = cropPoint(event);
  event.currentTarget.setPointerCapture(event.pointerId);
};
$('crop-overlay').onpointermove = event => {
  if (!cropAnchor || exporting) return;
  const point = cropPoint(event), w = Math.abs(point[0]-cropAnchor[0]), h = Math.abs(point[1]-cropAnchor[1]);
  if (w*video.videoWidth < 2 || h*video.videoHeight < 2) return;
  crop = [Math.min(point[0], cropAnchor[0]), Math.min(point[1], cropAnchor[1]), w, h]; renderCrop();
};
$('crop-overlay').onpointerup = $('crop-overlay').onpointercancel = event => {
  cropAnchor = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
};
new ResizeObserver(renderCrop).observe(video);
if (hosted) {
  $('trim-mode').value = 'precise';
  $('trim-mode').querySelector('[value="copy"]').disabled = true;
  renderCrop();
}
