import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import FileBrowserModal from './FileBrowserModal';
import { DEFAULT_PATHS } from '../constants/paths';
import { MdChevronLeft, MdChevronRight, MdClose, MdFolderOpen } from 'react-icons/md';

const cameraOrder = ['cam_left_head', 'cam_left_wrist', 'cam_right_wrist', 'cam_right_head'];
const EPISODE_STORAGE_KEY = 'cyclo_intelligence.reference_layout.episode_path';

function savedEpisodePath() {
  try { return window.sessionStorage.getItem(EPISODE_STORAGE_KEY) || ''; }
  catch (_error) { return ''; }
}

function videoUrl(episodePath, relativeFile) {
  const encoded = `${episodePath}/${relativeFile}`.split('/').map(encodeURIComponent).join('/');
  return `/files${encoded}`;
}

function parentDirectory(path) {
  const normalized = path.replace(/\/+$/, '');
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

function videoEpisodes(items, folder) {
  return (items || [])
    .filter((item) => item.has_videos && parentDirectory(item.path || '') === folder)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function numericEpisodeName(path) {
  const name = path.split('/').pop();
  return /^\d+$/.test(name) ? name : '';
}

function readFirstFrame(url, signal) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onAbort = () => fail(new Error('Cancelled'));
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    video.onerror = () => fail(new Error('Camera video could not be loaded'));
    video.onloadeddata = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) throw new Error('Camera frame is empty');
        canvas.getContext('2d').drawImage(video, 0, 0);
        const image = canvas.toDataURL('image/png');
        cleanup();
        resolve(image);
      } catch (error) { fail(error); }
    };
    timeout = setTimeout(() => fail(new Error('Camera frame timed out')), 10000);
    video.src = url;
  });
}

export default function ReferenceLayoutPanel({ isActive, onOverlayChange, onClose }) {
  const imageTopicList = useSelector((state) => state.ros.imageTopicList || []);
  const assignedImageTopics = useSelector((state) => state.ros.assignedImageTopics || []);
  const robotType = useSelector((state) => state.tasks.robotType);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [episodePath, setEpisodePath] = useState(savedEpisodePath);
  const [episodes, setEpisodes] = useState([]);
  const [episodeListStatus, setEpisodeListStatus] = useState('');
  const [segment, setSegment] = useState(null);
  const [opacity, setOpacity] = useState(40);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [jumpNumber, setJumpNumber] = useState(() => numericEpisodeName(savedEpisodePath()));
  const [jumpError, setJumpError] = useState('');
  const metadataGeneration = useRef(0);
  const frameGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const opacityRef = useRef(opacity);
  const overlayEnabledRef = useRef(overlayEnabled);
  opacityRef.current = opacity;
  overlayEnabledRef.current = overlayEnabled;
  const episodeParent = episodePath ? parentDirectory(episodePath) : '';

  useEffect(() => {
    if (!episodePath) return;
    try { window.sessionStorage.setItem(EPISODE_STORAGE_KEY, episodePath); }
    catch (_error) { /* Storage may be unavailable. */ }
  }, [episodePath]);

  useEffect(() => {
    if (!episodeParent || !isActive) return undefined;
    const controller = new AbortController();
    setEpisodes([]);
    setEpisodeListStatus('Loading episodes…');
    fetch(`/data-api/rosbag-list${episodeParent.split('/').map(encodeURIComponent).join('/')}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`Episode list: ${response.status}`); return response.json(); })
      .then((data) => {
        if (!data.success) throw new Error(data.message || 'Episode list unavailable');
        const available = videoEpisodes(data.rosbags, episodeParent);
        setEpisodes(available);
        setEpisodeListStatus(available.length ? '' : 'No recorded episodes with video in this folder.');
      })
      .catch((error) => { if (!controller.signal.aborted) setEpisodeListStatus(error.message); });
    return () => controller.abort();
  }, [episodeParent, isActive]);

  useEffect(() => {
    if (!episodePath || !isActive) return undefined;
    const controller = new AbortController();
    const current = ++metadataGeneration.current;
    setLoadError('');
    onOverlayChange({ frames: {}, enabled: false, opacity: opacityRef.current / 100 });
    fetch(`/data-api/replay-data${episodePath.split('/').map(encodeURIComponent).join('/')}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`Replay API: ${response.status}`); return response.json(); })
      .then((data) => {
        if (current !== metadataGeneration.current) return;
        if (!data.success) throw new Error(data.message || 'Replay data unavailable');
        const available = (data.video_segments || []).filter((item) => item.video_files?.length);
        if (!available.length && data.video_files?.length) {
          available.push({ name: 'Episode', video_files: data.video_files, video_names: data.video_names });
        }
        if (!available.length) throw new Error('No converted camera MP4s in this episode');
        setSegment(available[0]);
      })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    return () => { controller.abort(); metadataGeneration.current += 1; };
  }, [episodePath, isActive, onOverlayChange]);

  useEffect(() => {
    if (!segment || !isActive) return undefined;
    const controller = new AbortController();
    const current = ++frameGeneration.current;
    const timer = setTimeout(async () => {
      try {
        const selections = (segment.video_files || []).map((file, index) => ({
          file,
          name: segment.video_names?.[index] || file.split('/').pop().replace('.mp4', ''),
        })).filter((entry) => cameraOrder.includes(entry.name)
          && assignedImageTopics.includes(imageTopicList[cameraOrder.indexOf(entry.name)]));
        if (!selections.length) throw new Error('No matching camera names');
        const decoded = await Promise.all(selections.map(async ({ file, name }) => ({
          name, image: await readFirstFrame(videoUrl(episodePath, file), controller.signal),
        })));
        if (current !== frameGeneration.current || controller.signal.aborted) return;
        const frames = {};
        decoded.forEach(({ name, image }) => {
          const topic = imageTopicList[cameraOrder.indexOf(name)];
          if (topic) frames[topic] = image;
        });
        setLoadError('');
        onOverlayChange({ frames, enabled: overlayEnabledRef.current, opacity: opacityRef.current / 100 });
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(error.message);
          onOverlayChange({ frames: {}, enabled: false, opacity: opacityRef.current / 100 });
        }
      }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); frameGeneration.current += 1; };
  }, [segment, episodePath, imageTopicList, assignedImageTopics, isActive, onOverlayChange]);

  useEffect(() => {
    onOverlayChange((previous) => ({ ...previous, enabled: overlayEnabled && Object.keys(previous.frames || {}).length > 0,
      opacity: opacity / 100 }));
  }, [overlayEnabled, opacity, onOverlayChange]);

  useEffect(() => {
    if (!isActive) onOverlayChange((previous) => ({ ...previous, enabled: false }));
  }, [isActive, onOverlayChange]);

  const episodeIndex = episodes.findIndex((item) => item.path === episodePath);
  const selectEpisode = (path) => {
    if (!path || path === episodePath) return;
    selectionGeneration.current += 1;
    setJumpNumber(numericEpisodeName(path));
    setJumpError('');
    setSegment(null);
    setEpisodePath(path);
  };

  const selectFolder = async (item) => {
    const path = item.full_path?.replace(/\/+$/, '');
    if (!path) return;
    const current = ++selectionGeneration.current;
    try {
      const response = await fetch(`/data-api/rosbag-list${path.split('/').map(encodeURIComponent).join('/')}`);
      if (!response.ok) throw new Error(`Episode list: ${response.status}`);
      const data = await response.json();
      if (!data.success) throw new Error(data.message || 'Episode list unavailable');
      const available = videoEpisodes(data.rosbags, path);
      if (current !== selectionGeneration.current) return;
      selectEpisode((available.find((episode) => episode.name === '0') || available[0])?.path || path);
    } catch (_error) {
      if (current === selectionGeneration.current) selectEpisode(path);
    }
  };

  const jumpToEpisode = (event) => {
    event.preventDefault();
    const input = jumpNumber.trim();
    const number = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(number)) {
      setJumpError('Enter a valid episode folder number.');
      return;
    }
    const target = episodes.find((episode) => episode.name === input)
      || episodes.find((episode) => /^\d+$/.test(episode.name) && Number(episode.name) === number);
    if (!target) {
      setJumpError(`Episode number ${input} was not found.`);
      return;
    }
    selectEpisode(target.path);
    setJumpError('');
  };

  const selectRandomEpisode = () => {
    if (!episodes.length) return;
    const choices = episodes.length > 1
      ? episodes.filter((episode) => episode.path !== episodePath)
      : episodes;
    const target = choices[Math.floor(Math.random() * choices.length)];
    if (target) selectEpisode(target.path);
  };

  return (
    <section className="w-full bg-white border border-gray-200 rounded-2xl p-4" aria-label="Reference layout settings">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Reference layout</h2>
          <p className="text-xs text-gray-500 mt-1 mb-3">Overlay a recorded scene on the live cameras.</p>
        </div>
        <button type="button" aria-label="Close reference layout" onClick={onClose}
          className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400">
          <MdClose size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-stretch gap-2">
        <textarea aria-label="Episode folder" readOnly rows={2} value={episodePath}
          placeholder="Choose episode folder…" title={episodePath || undefined}
          className="min-w-0 flex-1 resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <button type="button" aria-label="Choose episode folder" title="Choose episode folder"
          className="flex w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-blue-600 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
          onClick={() => setBrowserOpen(true)}>
          <MdFolderOpen size={22} aria-hidden="true" />
        </button>
      </div>
      {loadError && <p className="mt-1 text-xs text-red-600" role="alert">{loadError}</p>}
      {episodePath && (
        <div className="mt-3 rounded-xl bg-gray-50 px-3 py-2" aria-label="Episode navigation">
          <div className="flex items-center justify-between gap-2">
            <button type="button" aria-label="Previous episode" title="Previous episode"
              disabled={episodeIndex <= 0}
              onClick={() => selectEpisode(episodes[episodeIndex - 1]?.path)}
              className="rounded-md p-1 text-gray-700 hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-400">
              <MdChevronLeft size={22} aria-hidden="true" />
            </button>
            <span className="min-w-0 truncate text-xs font-medium text-gray-700" title={episodeListStatus || undefined}>
              {episodeIndex >= 0 ? `Episode ${episodeIndex + 1}/${episodes.length}` : episodeListStatus || 'Episode not in this folder'}
            </span>
            <button type="button" aria-label="Next episode" title="Next episode"
              disabled={episodeIndex < 0 || episodeIndex >= episodes.length - 1}
              onClick={() => selectEpisode(episodes[episodeIndex + 1]?.path)}
              className="rounded-md p-1 text-gray-700 hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-400">
              <MdChevronRight size={22} aria-hidden="true" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-gray-200 pt-2">
            <form className="flex min-w-0 items-center gap-1.5" onSubmit={jumpToEpisode}>
              <label htmlFor="reference-episode-number" className="shrink-0 text-xs font-medium text-gray-600">Number</label>
              <input id="reference-episode-number" aria-label="Episode number" type="number" min="0" step="1"
                value={jumpNumber} onChange={(event) => { setJumpNumber(event.target.value); setJumpError(''); }}
                className="w-14 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-center text-xs focus:outline-none focus:ring-2 focus:ring-blue-400" />
              <button type="submit" disabled={!episodes.length}
                className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-400">OK</button>
            </form>
            <div className="shrink-0 border-l border-gray-200 pl-2">
              <button type="button" disabled={!episodes.length} onClick={selectRandomEpisode}
                className="rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-400">Random</button>
            </div>
          </div>
          {jumpError && <p className="mt-1 text-center text-xs text-red-600" role="alert">{jumpError}</p>}
        </div>
      )}
      <label className="block text-xs mt-3">Reference visibility: {opacity}%
        <input className="w-full mt-1" type="range" min="0" max="100" value={opacity}
          style={{ accentColor: '#2563eb' }} onChange={(event) => setOpacity(Number(event.target.value))} />
        <span className="flex justify-between text-[11px] font-normal text-gray-500">
          <span>More transparent ←</span><span>→ More visible</span>
        </span>
      </label>
      <button type="button" className={`w-full rounded-lg p-2 mt-3 text-sm ${overlayEnabled ? 'bg-blue-600 text-white' : 'border hover:bg-gray-50'}`}
        aria-pressed={overlayEnabled} onClick={() => setOverlayEnabled((enabled) => !enabled)}>Overlay {overlayEnabled ? 'on' : 'off'}</button>
      {robotType !== 'ffw_sg2_rev1' && <p className="text-xs text-amber-700">Camera mapping is available for ffw_sg2_rev1 recordings.</p>}
      <FileBrowserModal isOpen={browserOpen} onClose={() => setBrowserOpen(false)}
        onFileSelect={selectFolder}
        title="Select recorded episode folder" selectButtonText="Select" allowDirectorySelect allowFileSelect={false}
        initialPath={DEFAULT_PATHS.ROSBAG2_PATH} defaultPath={DEFAULT_PATHS.ROSBAG2_PATH} homePath="/workspace" />
    </section>
  );
}
