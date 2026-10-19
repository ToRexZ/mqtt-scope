// Fills in the download links from the latest GitHub release and points the
// main button at the right file for the visitor's operating system. Without
// JavaScript (or if the API is unavailable) every link still goes to the
// latest release page.

const REPO = 'ToRexZ/mqtt-scope';

function detectPlatform() {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return { key: 'win-x64-setup.exe', label: 'Download for Windows' };
  if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return { key: 'mac-arm64.dmg', label: 'Download for macOS' };
  if (/Linux|X11/i.test(platform + ua) && !/Android/i.test(ua)) return { key: 'linux-x86_64.AppImage', label: 'Download for Linux' };
  return null;
}

function formatSize(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}

async function main() {
  const platform = detectPlatform();
  const primary = document.getElementById('primary-download');
  if (platform) primary.textContent = platform.label;

  let release;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    release = await res.json();
  } catch {
    return;
  }
  const version = release.tag_name;
  const date = new Date(release.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  document.getElementById('release-meta').textContent = `Version ${version.replace(/^v/, '')} · ${date} · Free and open source (MIT)`;
  document.getElementById('version-line').textContent = `Latest release: ${version}, published ${date}.`;

  const find = (suffix) => release.assets.find((a) => a.name.endsWith(suffix));
  for (const link of document.querySelectorAll('[data-asset]')) {
    const asset = find(link.dataset.asset);
    if (!asset) continue;
    link.href = asset.browser_download_url;
    link.title = `${asset.name} (${formatSize(asset.size)})`;
    link.append(Object.assign(document.createElement('span'), { className: 'size', textContent: formatSize(asset.size) }));
  }
  const asset = platform && find(platform.key);
  if (asset) {
    primary.href = asset.browser_download_url;
    primary.title = asset.name;
  }
}

main();
