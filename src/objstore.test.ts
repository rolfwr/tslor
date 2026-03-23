

import { assert, test } from 'vitest'
import { ObjStore } from './objstore.js';


test('objstore', () => {
  const store = new ObjStore({ traceId: null });
  store.put({ id: 'a' });
  store.put({ id: 'b', groups: ['g1', 'g2'] });
  store.put({ id: 'c', groups: ['g1'] });
  store.put({ id: 'd', groups: ['g2'] });

  assert.equal(store.get('a')?.id, 'a');
  assert.equal(store.get('b')?.id, 'b');
  assert.equal(store.get('c')?.id, 'c');
  assert.equal(store.get('d')?.id, 'd');

  const g1Ids = store.getGroup('g1').map(obj => obj.id);
  assert.lengthOf(g1Ids, 2);
  assert.includeMembers(g1Ids, ['b', 'c']);

  const g2Ids = store.getGroup('g2').map(obj => obj.id);
  assert.lengthOf(g2Ids, 2);
  assert.includeMembers(g2Ids, ['b', 'd']);

  store.delete('b');

  assert.equal(store.get('b'), undefined);
  const g1Ids2 = store.getGroup('g1').map(obj => obj.id);
  assert.deepEqual(g1Ids2, ['c']);
});
