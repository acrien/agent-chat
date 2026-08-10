/**
 * jobs.js — what the heartbeat does, and each job's own settings.
 *
 * Two layers, both drawn from what rainsmoke3 sends, so neither knows a job's
 * name and adding one is a change in one project.
 */
import { el, els } from './dom.js';
import { post } from './transport.js';

// --- the jobs page ---------------------------------------------------------

/**
 * TWO LAYERS: what the heartbeat does, then one job's settings.
 *
 * Both drawn from what rainsmoke3 sends — label, description, enabled state,
 * and the tunables that job owns — so neither knows a job's name and adding one
 * is a change in one project.
 */
export function drawJobList(report) {
  const body = els.settingsBody;
  body.textContent = '';
  els.settingsTitle.textContent = 'jobs';
  els.settingsLead.textContent =
    'What the heartbeat does. Each runs on its own and carries its own settings.';

  for (const job of report.jobs ?? []) {
    const row = el('div', `jobRow ${job.enabled ? '' : 'off'}`);
    const head = el('div', 'jobRowHead');
    head.append(el('span', 'name', job.label));

    // Three buttons, one shape: they are the same KIND of control. The switch
    // stays distinct because it says what IS rather than where it goes.
    const toggle = el('button', 'pill on-off', job.enabled ? 'on' : 'off');
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', String(job.enabled));
    toggle.addEventListener('click', async () => {
      const res = await post('/api/jobs', { job: job.name, on: !job.enabled });
      if (res.ok) drawJobList(await res.json());
    });
    head.append(toggle);

    const count = (job.tunables ?? []).length;
    const config = el('button', 'pill', count ? `config (${count})` : 'config');
    config.type = 'button';
    config.addEventListener('click', () => drawJobConfig(report, job.name));
    head.append(config);

    const info = el('button', 'pill info', 'info');
    info.type = 'button';
    info.setAttribute('aria-expanded', 'false');
    head.append(info);
    row.append(head);

    const does = el('p', 'means', job.does);
    does.hidden = true;
    info.addEventListener('click', () => {
      does.hidden = !does.hidden;
      info.setAttribute('aria-expanded', String(!does.hidden));
      info.classList[does.hidden ? 'remove' : 'add']('open');
    });
    row.append(does);
    row.append(scheduleLine(job));
    body.append(row);
  }
}

/**
 * What the scheduler is about to do, and the one chance to stop it.
 *
 * THE COUNTDOWN IS THE SERVER'S, NOT THIS PAGE'S. A timer started here on
 * click would keep counting through a reload that lost it, and would keep
 * counting after the poller had already started the round — counting down to
 * something it has no way to confirm happened. So this only draws what
 * arrives, and re-asks while the number is still moving.
 *
 * CANCEL IS THE SWITCH. There is exactly one way to stop a round that has not
 * started, and inventing a second control that also stops it would mean two
 * mechanisms for one act — with the usual consequence that one of them ends up
 * being the one that does not quite work.
 */
function scheduleLine(job) {
  const s = job.schedule ?? {};
  const line = el('div', 'jobWhen');
  if (s.arming) {
    line.classList.add('arming');
    line.append(el('span', 'countdown', `starting in ${s.starts_in}s`));
    const stop = el('button', 'pill cancel', 'cancel');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      const res = await post('/api/jobs', { job: job.name, on: false });
      if (res.ok) drawJobList(await res.json());
    });
    line.append(stop);
    // Only while a countdown is live: a page that re-asked forever would poll
    // the server for a number that changes once every ten hours.
    setTimeout(async () => {
      const res = await post('/api/jobs', {});
      if (res.ok) drawJobList(await res.json());
    }, 1000);
  } else if (s.running) {
    line.append(el('span', 'runState', 'running'));
    if (s.queued) line.append(el('span', 'runState queued', '1 queued'));
  } else if (job.enabled) {
    line.append(el('span', 'runState idle', s.why || 'waiting'));
  }
  return line;
}

export function drawJobConfig(report, name) {
  const job = (report.jobs ?? []).find((j) => j.name === name);
  if (!job) return drawJobList(report);

  const body = els.settingsBody;
  body.textContent = '';
  els.settingsTitle.textContent = job.label;
  els.settingsLead.textContent = job.does;

  const back = el('button', 'pill back', '← all jobs');
  back.type = 'button';
  back.addEventListener('click', () => drawJobList(report));
  body.append(back);

  if (!job.enabled) {
    body.append(el('p', 'origin',
      'this job is switched off — its settings still apply when it runs'));
  }

  for (const t of job.tunables ?? []) {
    const row = el('div', 'tunable');
    const label = el('label');
    label.append(el('span', 'name', t.name.replace(/^heartbeat_|^miss_review_/, '').replace(/_/g, ' ')));
    const input = el('input');
    input.type = 'number';
    input.value = String(t.value);
    input.min = String(t.low);
    input.max = String(t.high);
    input.addEventListener('change', async () => {
      const res = await post('/api/jobs', { name: t.name, value: input.value });
      if (res.ok) drawJobConfig(await res.json(), name);
    });
    label.append(input);
    label.append(el('span', 'unit', t.unit));

    // The (i) carries the WHY. The registry knows it, so the page can offer it
    // without spending a paragraph on every setting by default.
    const why = el('button', 'iCircle', 'i');
    why.type = 'button';
    why.title = 'what this setting does';
    why.setAttribute('aria-expanded', 'false');
    label.append(why);
    row.append(label);

    const means = el('p', 'means', t.means);
    means.hidden = true;
    const origin = el('p', 'origin', t.owner_set
      ? `set by you · default ${t.default} ${t.unit} · range ${t.low}–${t.high}`
      : `default (${t.default} ${t.unit}) — you have not changed this · range ${t.low}–${t.high}`);
    origin.hidden = true;
    why.addEventListener('click', () => {
      means.hidden = origin.hidden = !means.hidden;
      why.setAttribute('aria-expanded', String(!means.hidden));
      why.classList[means.hidden ? 'remove' : 'add']('open');
    });
    row.append(means);
    row.append(origin);
    body.append(row);
  }
}

export const drawSettings = drawJobList;

export async function openSettings() {
  els.settings.hidden = false;
  els.settingsBody.textContent = 'loading…';
  const res = await fetch('/api/jobs').catch(() => null);
  // SAY WHICH THING FAILED. This reported "rainsmoke3 is not answering" for a
  // 404 — the server had simply not been restarted since the route was added.
  if (!res) {
    els.settingsBody.textContent = 'the page cannot reach the server.';
    return;
  }
  if (res.status === 404) {
    els.settingsBody.textContent =
      'this server build has no jobs route — it needs restarting to pick it up.';
    return;
  }
  if (!res.ok) {
    const why = await res.json().catch(() => ({}));
    els.settingsBody.textContent = why.error ?? `jobs unavailable (HTTP ${res.status}).`;
    return;
  }
  drawJobList(await res.json());
}

els.settingsOpen.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', () => { els.settings.hidden = true; });

els.beatHide.addEventListener('click', () => {
  els.beat.hidden = true;
  els.grip.hidden = true;
  els.beatShow.hidden = false;
});
els.beatShow.addEventListener('click', () => {
  els.beat.hidden = false;
  els.grip.hidden = false;
  els.beatShow.hidden = true;
});

