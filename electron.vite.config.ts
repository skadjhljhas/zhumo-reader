import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const chaoshengPreview = process.env.ZHUMO_THEME_PREVIEW === 'chaosheng'

export default defineConfig({
  main: {
    plugins: [
      {
        name: 'zhumo-native-file-ops',
        closeBundle: async () => {
          if (process.platform === 'win32')
            await promisify(execFile)(
              process.execPath,
              [resolve('scripts/build-native-file-ops.mjs')],
              { windowsHide: true }
            )
        }
      }
    ],
    define: { __CHAOSHENG_PREVIEW__: JSON.stringify(chaoshengPreview) },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'update-helper': resolve('src/main/update-helper.ts'),
          'program-files': resolve('src/main/program-files.ts'),
          'update-admission': resolve('src/main/update-admission.ts'),
          'profile-guard-client': resolve('src/main/profile-guard-client.ts'),
          'version-update': resolve('src/main/version-update.ts'),
          'version-launcher': resolve('src/main/version-launcher.ts'),
          'version-update-runner': resolve('src/main/version-update-runner.ts'),
          ...(process.env.ZHUMO_EXPERIMENTAL_SETUP === '1'
            ? {
                'setup-action': resolve('src/main/setup-action.ts'),
                'setup-withdrawal': resolve('src/main/setup-withdrawal.ts'),
                'setup-removal': resolve('src/main/setup-removal.ts'),
                'setup-cleanup': resolve('src/main/setup-cleanup.ts')
              }
            : {})
        }
      }
    }
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          meaning: resolve('src/renderer/meaning.html')
        }
      }
    },
    define: {
      PACKAGE_VERSION: JSON.stringify('3.2.2'),
      __CHAOSHENG_PREVIEW__: JSON.stringify(chaoshengPreview)
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
