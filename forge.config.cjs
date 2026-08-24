const { version } = require('./package.json');

const homepage = 'https://github.com/dorlanpabon/opencode-infinite-agent';
const description = 'Event-driven desktop supervisor for OpenCode sessions';

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.dorlanpabon.opencode-infinite',
    appCategoryType: 'public.app-category.developer-tools',
    executableName: 'OpenCodeInfinite',
    name: 'OpenCodeInfinite',
    win32metadata: {
      CompanyName: 'dorlanpabon',
      FileDescription: description,
      ProductName: 'OpenCode Infinite',
    },
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/(?:test|scripts|\.github)(?:\/|$)/,
      /^\/node_modules\/(?!electron-squirrel-startup(?:\/|$)|debug(?:\/|$)|ms(?:\/|$)).+/,
      /^\/dist\/.*\.(?:map|d\.(?:c|m)?ts)$/,
      /^\/(?!dist(?:\/|$)|src(?:\/|$)|bin(?:\/|$)|node_modules(?:\/|$)|package\.json$|README\.md$|SECURITY\.md$|LICENSE$).+/,
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
          categories: ['Development'],
          bin: 'OpenCodeInfinite',
        },
      },
    },
  ],
};
