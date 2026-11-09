// bun test preload: give unit tests a DOM (document, window, HTMLElement) via happy-dom.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
