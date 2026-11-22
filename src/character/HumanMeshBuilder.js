import {
  CharacterFactory,
  CharacterRig,
  CHARACTER_PRESETS,
  CHARACTER_LABELS,
} from './CharacterFactory.js';

export { CharacterFactory, CharacterRig, CHARACTER_PRESETS, CHARACTER_LABELS };

/**
 * Backward-compatible wrapper delegating cleanly to CharacterFactory.createCharacter('liam').
 * Preserves full compatibility with `new HumanMeshBuilder(options)`.
 */
export class HumanMeshBuilder {
  constructor(options = {}) {
    const preset = typeof options?.preset === 'string' ? options.preset : 'liam';
    return CharacterFactory.createCharacter(preset, options);
  }
}
