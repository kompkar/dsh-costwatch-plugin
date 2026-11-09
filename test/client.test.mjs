import assert from 'node:assert/strict';
import test from 'node:test';

test('the client bundle registers the ticker in shell.bottom', async () => {
  let injectedKey;
  let registration;
  let bundleId;

  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
  };

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        bundleId = id;
        const exports = factory((request) => {
          assert.equal(request, 'react');
          return reactStub;
        });
        assert.equal(typeof exports.apply, 'function');
        assert.deepEqual(exports.inject, ['slots']);

        const ctx = {
          slots: {
            inject(key, callback) {
              injectedKey = key;
              callback();
            },
            register(definition, component) {
              registration = { definition, component };
            },
          },
        };
        exports.apply(ctx);
      },
    },
  };

  await import('../lib/client.js');

  assert.equal(bundleId, 'dsh-costwatch-plugin');
  assert.equal(injectedKey, 'shell.bottom');
  assert.equal(registration.definition.name, 'shell.bottom');
  assert.equal(registration.definition.id, 'dsh-costwatch-plugin');
  assert.equal(typeof registration.component, 'function');
});
