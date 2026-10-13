import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import { audioEngine } from '@/game/systems/audio';
import { Button, Panel, SettingRow, Slider, Toggle } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';
import { hapticsSupported } from '@/utils/haptics';

export type SettingsGroup = 'audio' | 'readability' | 'controls' | 'performance';

/**
 * Volume + feel controls, in four blocks.
 *
 * `group` lets the settings screen lay the blocks out as panels side by side —
 * one long column of fourteen rows was taller than a laptop screen, which made the
 * page look like it ran off the bottom. The pause menu asks for no group and gets
 * the whole stack in reading order, which is what a narrow overlay needs.
 */
export function SettingsControls({ group }: { group?: SettingsGroup } = {}) {
  const volumes = useSettingsStore(useShallow((s) => ({
    masterVolume: s.masterVolume,
    sfxVolume: s.sfxVolume,
    musicVolume: s.musicVolume,
  })));
  const screenShake = useSettingsStore((s) => s.screenShake);
  const damageNumbers = useSettingsStore((s) => s.damageNumbers);
  const pixelEffects = useSettingsStore((s) => s.pixelEffects);
  const reducedMotion = useSettingsStore((s) => s.reducedMotion);
  const highContrast = useSettingsStore((s) => s.highContrast);
  const autoAim = useSettingsStore((s) => s.autoAim);
  const graphicsQuality = useSettingsStore((s) => s.graphicsQuality);
  const showTouchControls = useSettingsStore((s) => s.showTouchControls);
  const showFps = useSettingsStore((s) => s.showFps);
  const hudScale = useSettingsStore((s) => s.hudScale);
  const haptics = useSettingsStore((s) => s.haptics);
  const setValue = useSettingsStore((s) => s.set);
  const toggle = useSettingsStore((s) => s.toggle);

  const hapticsAvailable = hapticsSupported();
  const on = (name: SettingsGroup) => !group || group === name;

  return (
    <>
      {on('audio') ? (
        <>
          <SettingRow label="Master volume">
            <div className="row slider-row">
              <Slider label="Master volume" value={volumes.masterVolume} onChange={(value) => setValue('masterVolume', value)} />
              <span className="mono-value tiny">{Math.round(volumes.masterVolume * 100)}</span>
            </div>
          </SettingRow>
          <SettingRow label="Effects volume">
            <div className="row slider-row">
              <Slider label="Effects volume" value={volumes.sfxVolume} onChange={(value) => setValue('sfxVolume', value)} />
              <span className="mono-value tiny">{Math.round(volumes.sfxVolume * 100)}</span>
            </div>
          </SettingRow>
          <SettingRow label="Music volume" hint="Procedural ambient bed, generated per floor.">
            <div className="row slider-row">
              <Slider label="Music volume" value={volumes.musicVolume} onChange={(value) => setValue('musicVolume', value)} />
              <span className="mono-value tiny">{Math.round(volumes.musicVolume * 100)}</span>
            </div>
          </SettingRow>
        </>
      ) : null}

      {on('readability') ? (
        <>
          <SettingRow label="Screen shake" hint="Impact and explosion camera shake.">
            <Toggle checked={screenShake} label="Screen shake" onChange={() => toggle('screenShake')} />
          </SettingRow>
          <SettingRow label="Damage numbers" hint="Floating combat text.">
            <Toggle checked={damageNumbers} label="Damage numbers" onChange={() => toggle('damageNumbers')} />
          </SettingRow>
          <SettingRow label="Pixel effects" hint="Particle sprays, sparks and debris.">
            <Toggle checked={pixelEffects} label="Pixel effects" onChange={() => toggle('pixelEffects')} />
          </SettingRow>
          <SettingRow label="Reduced motion" hint="Removes flashes, zoom punches and heavy shake.">
            <Toggle checked={reducedMotion} label="Reduced motion" onChange={() => toggle('reducedMotion')} />
          </SettingRow>
          <SettingRow label="High contrast" hint="Stronger borders and brighter text.">
            <Toggle checked={highContrast} label="High contrast" onChange={() => toggle('highContrast')} />
          </SettingRow>
        </>
      ) : null}

      {on('controls') ? (
        <>
          <SettingRow label="Auto-aim assist" hint="Below 40% the assist is off.">
            <div className="row slider-row">
              <Slider label="Auto-aim assist" value={autoAim} onChange={(value) => setValue('autoAim', value)} />
              <span className="mono-value tiny">{autoAim < 0.4 ? 'OFF' : `${Math.round(autoAim * 100)}%`}</span>
            </div>
          </SettingRow>
          <SettingRow label="Touch controls" hint="Auto shows the pads on touch devices only.">
            <div className="row" style={{ gap: 6 }}>
              {(['auto', 'always', 'never'] as const).map((mode) => (
                <Button
                  key={mode}
                  size="small"
                  variant={showTouchControls === mode ? 'primary' : 'default'}
                  onClick={() => setValue('showTouchControls', mode)}
                >
                  {mode.toUpperCase()}
                </Button>
              ))}
            </div>
          </SettingRow>
          <SettingRow
            label="Interface scale"
            hint={`HUD text and controls at ${Math.round(hudScale * 100)}%.`}
          >
            <Slider
              label="Interface scale"
              value={hudScale}
              min={0.85}
              max={1.45}
              step={0.05}
              onChange={(value) => setValue('hudScale', value)}
            />
          </SettingRow>
          <SettingRow
            label="Haptics"
            hint={
              hapticsAvailable
                ? 'Vibration on heavy impacts, damage, boss phases and unlocks.'
                : 'No vibration motor here; the game is unchanged with this on.'
            }
          >
            <Toggle checked={haptics} label="Haptics" onChange={() => toggle('haptics')} />
          </SettingRow>
        </>
      ) : null}

      {on('performance') ? (
        <>
          <SettingRow label="Graphics quality" hint="Lowers particle and effect density.">
            <div className="row" style={{ gap: 6 }}>
              {(['low', 'medium', 'high'] as const).map((quality) => (
                <Button
                  key={quality}
                  size="small"
                  variant={graphicsQuality === quality ? 'primary' : 'default'}
                  onClick={() => setValue('graphicsQuality', quality)}
                >
                  {quality.toUpperCase()}
                </Button>
              ))}
            </div>
          </SettingRow>
          <SettingRow label="Show FPS" hint="Frame rate and live entity count in the HUD.">
            <Toggle checked={showFps} label="Show FPS" onChange={() => toggle('showFps')} />
          </SettingRow>
        </>
      ) : null}
    </>
  );
}

/** The four actions that are not settings, kept together so both hosts match. */
export function SettingsActions() {
  const setValue = useSettingsStore((s) => s.set);
  const reset = useSettingsStore((s) => s.reset);

  const requestFullscreen = useCallback(() => {
    const element = document.documentElement;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void element.requestFullscreen?.().catch(() => {
      useUiStore.getState().pushToast({
        title: 'FULLSCREEN BLOCKED',
        body: 'Your browser refused the request. Try the fullscreen key (F11).',
        color: '#FF5C6C',
      });
    });
  }, []);

  return (
    <div className="row settings-actions">
      <Button size="small" onClick={requestFullscreen}>
        TOGGLE FULLSCREEN
      </Button>
      <Button
        size="small"
        onClick={() => {
          setValue('autoAim', 0.65);
          setValue('showTouchControls', 'auto');
          setValue('hudScale', 1);
          useUiStore.getState().pushToast({
            title: 'CONTROLS RESET',
            body: 'Aim assist and touch layout restored to defaults.',
            color: '#7E899E',
          });
        }}
      >
        RESET CONTROLS
      </Button>
      <Button
        size="small"
        variant="danger"
        onClick={() => {
          reset();
          useUiStore.getState().pushToast({ title: 'SETTINGS RESET', color: '#FF5C6C' });
        }}
      >
        RESET ALL SETTINGS
      </Button>
      <Button
        size="small"
        onClick={() => {
          audioEngine.unlock();
          audioEngine.play('ui_click');
        }}
      >
        TEST AUDIO
      </Button>
    </div>
  );
}

/** Compact settings body used inside the pause overlay. */
export function PauseSettingsPanel() {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="section-label">SETTINGS</div>
      <SettingsControls />
      <SettingsActions />
    </div>
  );
}

export function SettingsScreen() {
  const back = useUiStore((s) => s.back);
  return (
    <Screen className="settings-screen">
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <h1 className="title-xl">SETTINGS</h1>
          <p className="subtitle">Audio, readability and performance. Everything is stored locally on this device.</p>
        </header>

        {/* Four blocks side by side rather than one tall column: at 1366×768 the
            single column needed 1205 px of scroll for 14 rows. */}
        <div className="grid cols-2 settings-grid">
          <Panel title="AUDIO">
            <SettingsControls group="audio" />
          </Panel>
          <Panel title="READABILITY">
            <SettingsControls group="readability" />
          </Panel>
          <Panel title="CONTROLS">
            <SettingsControls group="controls" />
          </Panel>
          <Panel title="PERFORMANCE">
            <SettingsControls group="performance" />
            <div className="separator" />
            <SettingsActions />
          </Panel>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={back}>BACK</Button>
        </div>
      </div>
    </Screen>
  );
}
