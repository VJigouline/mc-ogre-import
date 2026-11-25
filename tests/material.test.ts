import { describe, expect, it } from 'vitest';
import { mainTechnique, OgreMaterialLibrary, parseMaterialScript, parseScript } from '../src/index.js';

describe('script syntax', () => {
  it('reads objects, properties, comments and quoted names', () => {
    const nodes = parseScript(`
      // a comment
      material "My Material" : Base /* inline */
      {
        technique { pass { diffuse 1 0 0 } }
      }
      vertex_program Prog glsl
      {
        source prog.vert
      }
    `);
    expect(nodes).toHaveLength(2);
    const [material, program] = nodes;
    expect(material).toMatchObject({ object: true, type: 'material', name: 'My Material', parent: 'Base' });
    expect(program).toMatchObject({ type: 'vertex_program', name: 'Prog', extra: ['glsl'] });
    const pass = (material as any).children[0].children[0];
    expect(pass.children[0]).toMatchObject({ object: false, name: 'diffuse', values: ['1', '0', '0'] });
  });

  it('splits a colon written against a name', () => {
    const [node] = parseScript('material Child: Parent\n{\n}\n');
    expect(node).toMatchObject({ name: 'Child', parent: 'Parent' });
  });
});

describe('materials', () => {
  it('reads pass colours, blending and texture units, with defaults', () => {
    const [material] = parseMaterialScript(`
      material Glass
      {
        receive_shadows off
        technique
        {
          pass
          {
            ambient 0.5 0.5 0.5
            diffuse 0.2 0.4 0.6 0.5
            specular 1 1 1 1 64
            emissive 0.1 0 0
            scene_blend alpha_blend
            depth_write off
            cull_hardware none
            alpha_rejection greater_equal 128
            texture_unit diffuse
            {
              texture glass.png
              tex_address_mode clamp
              scale 2 4
              scroll 0.25 0.5
              rotate 90
              tex_coord_set 1
            }
          }
        }
      }`);
    expect(material!.name).toBe('Glass');
    expect(material!.receiveShadows).toBe(false);
    const pass = mainTechnique(material!)!.passes[0]!;
    expect(pass.diffuse).toEqual([0.2, 0.4, 0.6, 0.5]);
    expect(pass.ambient).toEqual([0.5, 0.5, 0.5, 1]);
    expect(pass.specular).toEqual([1, 1, 1, 1]);
    expect(pass.shininess).toBe(64);
    expect(pass.emissive).toEqual([0.1, 0, 0, 1]);
    expect(pass.sceneBlend).toBe('alpha');
    expect(pass.depthWrite).toBe(false);
    expect(pass.cullHardware).toBe('none');
    expect(pass.alphaRejection).toEqual({ func: 'greater_equal', value: 128 });
    expect(pass.textureUnits[0]).toMatchObject({
      name: 'diffuse',
      texture: 'glass.png',
      addressMode: ['clamp', 'clamp', 'clamp'],
      scale: [2, 4],
      scroll: [0.25, 0.5],
      rotate: 90,
      texCoordSet: 1,
    });
  });

  it('reads specular with four values and vertex colours', () => {
    const [m] = parseMaterialScript('material A { technique { pass { specular 0.5 0.5 0.5 20\n diffuse vertexcolour\n scene_blend one one } } }');
    const pass = m!.techniques[0]!.passes[0]!;
    expect(pass.specular).toEqual([0.5, 0.5, 0.5, 1]);
    expect(pass.shininess).toBe(20);
    expect(pass.diffuse).toBe('vertexcolour');
    expect(pass.sceneBlend).toBe('add');
  });

  it('inherits from materials and abstract objects in other scripts, with variables', () => {
    const library = new OgreMaterialLibrary();
    library.add(
      `abstract material Textured
      {
        set $tex white.png
        set $colour 1 1 1
        technique
        {
          pass main
          {
            diffuse $colour
            texture_unit { texture $tex }
          }
          pass decal
          {
            scene_blend add
          }
        }
      }`,
      'base.material',
    );
    library.add(
      `material Brick : Textured
      {
        set $tex brick.png
        set $colour 0.8 0.3 0.2
        technique
        {
          pass decal
          {
            depth_write off
          }
        }
      }
      material Plain : Textured {}`,
      'brick.material',
    );
    expect(library.names).toEqual(['Brick', 'Plain']);
    expect(library.has('Textured')).toBe(false);
    const brick = library.get('Brick')!;
    expect(brick.file).toBe('brick.material');
    const [main, decal] = brick.techniques[0]!.passes;
    expect(main!.diffuse).toEqual([0.8, 0.3, 0.2, 1]);
    expect(main!.textureUnits[0]!.texture).toBe('brick.png');
    expect(decal!.sceneBlend).toBe('add');
    expect(decal!.depthWrite).toBe(false);
    expect(library.get('Plain')!.techniques[0]!.passes[0]!.textureUnits[0]!.texture).toBe('white.png');
    expect(library.get('Missing')).toBeNull();
  });

  it('warns about a missing parent', () => {
    const library = new OgreMaterialLibrary();
    library.add('material A : Nowhere { technique { pass { } } }');
    expect(library.get('A')!.techniques).toHaveLength(1);
    expect(library.warnings[0]).toMatch(/Nowhere/);
  });

  it('picks the first technique of the default scheme and LOD', () => {
    const [m] = parseMaterialScript(`material T
      {
        technique hi { scheme HighQuality
          pass { diffuse 1 0 0 } }
        technique far { lod_index 1
          pass { diffuse 0 1 0 } }
        technique normal { pass { diffuse 0 0 1 } }
      }`);
    expect(mainTechnique(m!)!.name).toBe('normal');
  });

  it('reads RTSS normal maps and metal-roughness, and material texture aliases', () => {
    const [m] = parseMaterialScript(`material PBR
      {
        set_texture_alias albedo rock.png
        technique { pass {
          specular 0 0.6 0.9 0
          texture_unit { texture_alias albedo
            texture placeholder.png }
          rtshader_system
          {
            lighting_stage metal_roughness texture rock_mr.png
            lighting_stage normal_map rock_n.png tangent_space
          }
        } }
      }`);
    const pass = m!.techniques[0]!.passes[0]!;
    expect(m!.textureAliases).toEqual({ albedo: 'rock.png' });
    expect(pass.textureUnits[0]!.alias).toBe('albedo');
    expect(pass.metalRoughness).toEqual({ texture: 'rock_mr.png' });
    expect(pass.normalMap).toBe('rock_n.png');
  });
});
