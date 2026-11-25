/** Set at build time by vite.config.ts (`HOSTRY_TARGET=native` for the native shell's bundle; anything else is the browser build). */
declare const __HOSTRY_TARGET__: "browser" | "native";
/** Set at build time by vite.config.ts (`HOSTRY_RELEASE=1`): a build meant to ship. */
declare const __HOSTRY_RELEASE__: boolean;
