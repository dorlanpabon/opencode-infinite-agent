const path = require('node:path');
const { version } = require('./package.json');
const { prepareLinuxRpmMaker } = require('./scripts/prepare-linux-rpm-maker.cjs');

const homepage = 'https://github.com/dorlanpabon/opencode-infinite-agent';
const description = 'Event-driven desktop supervisor for OpenCode sessions';
const iconBase = path.join(__dirname, 'assets', 'icon');
const iconPng = `${iconBase}.png`;

module.exports = {
  hooks: {
    preMake: prepareLinuxRpmMaker,
  },
  packagerConfig: {
    asar: true,
    appBundleId: 'com.dorlanpabon.opencode-infinite',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'OpenCodeInfinite',
    icon: iconBase,
    name: 'OpenCodeInfinite',
    win32metadata: {
      CompanyName: 'dorlanpabon',
      FileDescription: description,
      ProductName: 'OpenCode Infinite',
    },
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/(?:test|scripts|\.github)(?:\/|$)/,
      /^\/assets\/(?!icon\.png$).+/,
      /^\/node_modules\/(?!electron-squirrel-startup(?:\/|$)|debug(?:\/|$)|ms(?:\/|$)).+/,
      /^\/dist\/.*\.(?:map|d\.(?:c|m)?ts)$/,
      /^\/(?!assets(?:\/|$)|dist(?:\/|$)|node_modules(?:\/|$)|package\.json$|README\.md$|SECURITY\.md$|LICENSE$).+/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'OpenCodeInfinite',
        authors: 'dorlanpabon',
        description,
        setupIcon: `${iconBase}.ico`,
        setupExe: `OpenCode-Infinite-${version}-Setup.exe`,
        title: 'OpenCode Infinite',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'opencode-infinite',
          productName: 'OpenCode Infinite',
          genericName: 'AI Development Tool',
          description,
          productDescription: description,
          section: 'devel',
          maintainer: 'dorlanpabon',
          homepage,
          icon: iconPng,
          categories: ['Development'],
          bin: 'OpenCodeInfinite',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'opencode-infinite',
          productName: 'OpenCode Infinite',
          genericName: 'AI Development Tool',
          description,
          productDescription: description,
          license: 'MIT',
          group: 'Development/Tools',
          homepage,
          icon: iconPng,
          categories: ['Development'],
          bin: 'OpenCodeInfinite',
        },
      },
    },
  ],
};
