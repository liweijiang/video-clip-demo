#!/usr/bin/env python3
"""Loopback-only video trimmer. Python standard library + FFmpeg."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
FFMPEG = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
FFPROBE = shutil.which('ffprobe') or '/opt/homebrew/bin/ffprobe'
MAX_BYTES = 8 * 1024 ** 3
JOBS = {}
JOBS_LOCK = threading.Lock()


def run(command, cancelled):
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        deadline = time.monotonic() + 600
        while True:
            if cancelled.is_set() or time.monotonic() > deadline:
                process.kill()
                process.communicate()
                raise ValueError('Export cancelled or processing timed out.')
            try:
                out, error = process.communicate(timeout=.2)
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode:
            raise ValueError('FFmpeg could not export this video/audio into MP4. '
                             'The source may be damaged or use codecs unsupported by MP4. '
                             'No quality-reducing conversion was performed.\n' + error.decode(errors='replace')[-1200:])
        return out


def clip(source, output, start, end, cancelled, crop=None, precise=False):
    info = json.loads(run([FFPROBE, '-v', 'error', '-show_format', '-show_streams',
                           '-of', 'json', str(source)], cancelled))
    if not any(s['codec_type'] == 'video' for s in info['streams']):
        raise ValueError('The selected file has no video stream.')
    duration = float(info['format']['duration'])
    if not math.isfinite(duration) or start >= duration or end > duration + .25:
        raise ValueError('The selected times are outside the source video.')
    encoding = ['-c', 'copy']
    if precise:
        encoding = ['-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-crf', '18',
                    '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
    if crop is not None:
        if (not isinstance(crop, list) or len(crop) != 4 or
                any(type(v) not in (int, float) or not math.isfinite(v) for v in crop)):
            raise ValueError('Invalid crop region.')
        x, y, w, h = crop
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > 1.00000001 or y+h > 1.00000001:
            raise ValueError('Crop region must be inside the video.')
        stream = next(s for s in info['streams'] if s['codec_type'] == 'video')
        width, height = stream['width'], stream['height']
        rotation = next((d.get('rotation', 0) for d in stream.get('side_data_list', []) if 'rotation' in d), 0)
        if abs(rotation) % 180 == 90:
            width, height = height, width
        if w * width < 2 or h * height < 2:
            raise ValueError('Crop region is too small; select at least two pixels per side.')
        encoding = ['-vf', f'crop=trunc(iw*{w}/2)*2:trunc(ih*{h}/2)*2:trunc(iw*{x}/2)*2:trunc(ih*{y}/2)*2',
                    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']
    # Re-encoding discards decoded frames before the requested start. Stream
    # copy remains optional and retains the preceding keyframe. Cropping always
    # re-encodes. Avoid shifting encoded output forward by its B-frame delay.
    run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
         '-ss', str(start), '-i', str(source), '-t', str(min(end, duration) - start),
         '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '-1',
         *encoding, '-avoid_negative_ts', 'disabled' if precise or crop is not None else 'make_zero', '-movflags', '+faststart',
         str(output)], cancelled)
    if not output.exists() or output.stat().st_size == 0:
        raise ValueError('FFmpeg did not produce a clip.')


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def local_request(self):
        allowed = {f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'}
        origin = self.headers.get('Origin')
        return (self.headers.get('Host') in allowed and
                (not origin or origin in {'http://' + host for host in allowed}))

    def respond(self, code, body, content_type='application/json'):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.local_request():
            return self.respond(403, {'error': 'Local access only.'})
        path = urlsplit(self.path).path
        if path == '/api/health':
            return self.respond(200, {'ready': os.path.isfile(FFMPEG) and os.path.isfile(FFPROBE)})
        files = {'/': ('index.html', 'text/html; charset=utf-8'),
                 '/index.html': ('index.html', 'text/html; charset=utf-8'),
                 '/style.css': ('style.css', 'text/css'), '/app.js': ('app.js', 'text/javascript')}
        if path not in files:
            return self.respond(404, {'error': 'Not found.'})
        name, mime = files[path]
        self.respond(200, (ROOT / name).read_bytes(), mime)

    def do_POST(self):
        if not self.local_request() or self.headers.get('X-Cutroom-Export') != '1':
            return self.respond(403, {'error': 'Local access only.'})
        url = urlsplit(self.path)
        params = parse_qs(url.query)
        job_id = params.get('id', [''])[0]
        if not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', job_id):
            return self.respond(400, {'error': 'Invalid export identifier.'})
        if url.path == '/api/cancel':
            with JOBS_LOCK:
                if job_id in JOBS:
                    JOBS[job_id].set()
            return self.respond(200, {'cancelled': True})
        if url.path != '/api/export':
            return self.respond(404, {'error': 'Not found.'})
        cancelled = threading.Event()
        with JOBS_LOCK:
            if job_id in JOBS:
                return self.respond(409, {'error': 'Export already exists.'})
            JOBS[job_id] = cancelled
        try:
            start = float(params.get('start', ['nan'])[0])
            end = float(params.get('end', ['nan'])[0])
            name = params.get('name', [''])[0]
            if not all(map(math.isfinite, [start, end])) or start < 0 or end <= start:
                raise ValueError('Select valid start and end times.')
            if name not in {'safe.mp4', 'unsafe.mp4'}:
                raise ValueError('Choose safe.mp4 or unsafe.mp4.')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BYTES:
                raise ValueError('Choose a nonempty video smaller than 8 GB.')
            with tempfile.TemporaryDirectory(prefix='cutroom-') as folder:
                source, output = Path(folder) / 'source', Path(folder) / name
                with source.open('wb') as target:
                    remaining = size
                    while remaining:
                        if cancelled.is_set():
                            raise ValueError('Export cancelled.')
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('Video transfer was interrupted.')
                        target.write(chunk)
                        remaining -= len(chunk)
                crop = json.loads(params['crop'][0]) if 'crop' in params else None
                clip(source, output, start, end, cancelled, crop, precise=params.get('mode', ['precise'])[0] != 'copy')
                if cancelled.is_set():
                    raise ValueError('Export cancelled.')
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', str(output.stat().st_size))
                self.send_header('Content-Disposition', f'attachment; filename="{name}"')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                with output.open('rb') as result:
                    shutil.copyfileobj(result, self.wfile)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except (ValueError, KeyError, FileNotFoundError) as error:
            try:
                self.respond(400, {'error': str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
        finally:
            with JOBS_LOCK:
                JOBS.pop(job_id, None)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    if not os.path.isfile(FFMPEG) or not os.path.isfile(FFPROBE):
        parser.error('Install FFmpeg first: brew install ffmpeg')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Cutroom: http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
