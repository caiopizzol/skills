import { defaultExclude, defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    exclude: [...defaultExclude, "apps/catalog-validation-cli/tests/**", "scripts/tests/**"],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
