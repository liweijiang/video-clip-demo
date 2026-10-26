# Cutroom video clipping demo

The hosted build exports clips entirely in the browser, so source videos stay on the user's device. It produces MP4 when the browser supports MP4 recording and WebM otherwise. The local Python mode below remains available for precise FFmpeg trimming and original-quality keyframe cuts.

## Quick start

1. Unzip the download.
2. Install Python 3.9 or newer and FFmpeg (including `ffprobe`). Make sure they are on your system PATH. No additional Python packages are required. On macOS with Homebrew, run `brew install python ffmpeg`.
3. Open a terminal in the extracted `video-clip-demo` folder and start the server:

   - macOS / Linux: `python3 server.py`
   - Windows: `py server.py` (or `python server.py`)

4. Keep the terminal running and open http://localhost:8000 in your browser.

Stop the server with Ctrl+C. If port 8000 is already in use, run `python3 server.py --port 8001` (Windows: `py server.py --port 8001`) and open http://localhost:8001.

Python and FFmpeg are prerequisites and are not bundled in this ZIP.

Open http://localhost:8000. A plain static HTTP server or opening index.html directly cannot perform exports.

Choose a local video, drag the green handles or enter times, preview the selection, choose **safe.mp4** or **unsafe.mp4**, and select **Save clip**. Arrow keys adjust focused handles by 0.1 seconds (Shift: 1 second).

## Original-quality export

When **Original quality — keyframe cuts** is selected (with cropping off), the local Python server runs FFmpeg with `-c copy`: it copies the first video stream and all audio streams without decoding/re-encoding, resizing, changing frame rate, or reducing quality. Source rotation and stream metadata are retained where MP4 supports them. Exports no longer depend on browser playback, tab visibility, or a 30 fps recorder.

Lossless cuts are not frame-exact. Input seeking retains frames from the preceding keyframe, so a saved clip can start earlier than the preview selection. End boundaries are packet-aligned and may differ slightly due to frame reordering and audio packet duration. Choose frame-accurate re-encoding in another editor if exact boundaries are essential. See [FFmpeg stream copying and seeking](https://ffmpeg.org/ffmpeg.html#Stream-copy).

The MP4 container must support the original codecs. If it does not, export fails with an explanation; the app never silently converts to lower quality. The selected name is used for the download; browsers may add a number if the file already exists.

Videos transfer only to the server on your own machine, bound to 127.0.0.1. Temporary source and output files are deleted after download or failure. No cloud service or Python packages are needed. Maximum source size is 8 GB; individual processing commands time out after 10 minutes. Cancel stops processing and preserves your selection.

## Validation

Run `python3 -m unittest -v test_server.py`. Integration tests create a 60 fps source, export clips, compare encoded packet hashes and stream properties, decode the result, and test invalid selections, corrupt files, silent video, and cancellation.

## Crop a region

Enable **Crop video**, then drag across the preview to draw the region to keep. Draw again to replace it, adjust Left/Top/Width/Height percentages for precision, or select **Reset crop** for the full frame. Cropping follows the displayed orientation, including rotated phone videos.

Cropped exports re-encode video to H.264 at CRF 18 and audio to AAC; they are not lossless. Width and height round down to even pixels. With cropping disabled, choose precise timing or original-quality keyframe cuts. Processing remains on your machine.

## Precise time trimming

**Precise — selected times** is the default. It re-encodes H.264 video and AAC audio to trim at the selected start/end (within media frame granularity). Cropping always uses precise trimming. **Original quality — keyframe cuts** preserves encoded packets but can start earlier than selected.
