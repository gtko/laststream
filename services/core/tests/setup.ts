import { setPlatform } from '../src/platform/index.js';
import { createNodePlatform } from '../src/platform/node/index.js';

setPlatform(createNodePlatform());
