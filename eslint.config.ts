import antfu from '@antfu/eslint-config'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

const styleConfig = await antfu({
  type: 'lib',
  lessOpinionated: true,
  ignores: ['dist/**', 'node_modules/**'],
  markdown: false,
  typescript: {
    tsconfigPath: 'tsconfig.json',
  },
})

export default defineConfig(
  ...styleConfig,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
