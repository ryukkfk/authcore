# S1 transaction-owner — BLOCKED prerequisite

D06/S1 ကို repository owner က ဤ implementation task အတွက်သာ approve လုပ်ထားသည်။
S0 base: `822062fea79fad3e5a8547dc9f7b40b999f7cb71`။
Design: `49fc8e9f63bd40bedcf83bd3b10823732ae4dba7`။
ဤ branch သည် repaired transaction owner မဟုတ်ပါ။ Production source ကို S0 အတိုင်း ထိန်းထားသည်။

## Verified blocking case

Installed `pg@8.23.1` / `pg-pool@3.14.0` ကိုသုံးသော
`src/signup-pool-ownership.test.ts` က real pool / synthetic transport ဖြင့် ပြသည်။

1. Checkout ၏ local transport ကို `client.end()` ဖြင့် ပိတ်သည်။
2. `client.release(true)` သည် release-once flag ကို consumed လုပ်သည်။
3. `pool.emit('release', ...)` အတွင်း controlled listener exception ဖြစ်သည်။
4. `_remove` မရောက်သဖြင့် pool မှာ `totalCount=1`, `idleCount=0` ကျန်သည်။
5. ထပ်ခေါ်သော `release(true)` က double-release error ဖြစ်သည်။
6. ထပ်ခေါ်သော `end()` က pool bookkeeping ကို မဖယ်ရှားပါ။
7. `pool.end()` သည် retained checkout ကြောင့် မပြီးပါ။

`src/signup-pool-ownership.integration.test.ts` သည် ထို lifecycle case ကို
CI-owned randomized PostgreSQL database အတွင်း ထပ်စမ်းသည်။ Exact COMMIT tag,
independent committed marker, server-confirmed backend absence နှင့် retained pool
bookkeeping ကို ခွဲ၍စစ်သည်။ ဒီ test PASS သည် blocker characterization အောင်မြင်ခြင်းသာ ဖြစ်သည်။

[Documented pool API](https://node-postgres.com/apis/pool) တွင် release(destroy),
end နှင့် lifecycle events ပါသည်။ Consumed release callback အတွက် idempotent
per-checkout eviction receipt/recovery API မတွေ့ပါ။ Installed source ordering ကို
test က တိုက်ရိုက်စစ်ထားသည်။ Private `_remove`/`_pulseQueue` ကို exact fixture-owned
checkout cleanup အတွက်သာ သုံးသည်။ Production workaround အဖြစ် မသုံးပါ။

## Gate and scope

Owner instruction က installed pool API ဖြင့် bounded ownership contract မဖြည့်နိုင်လျှင်
precise failure case ကို ဖော်ပြပြီး ရပ်ရန် သတ်မှတ်ထားသည်။
ဤ schedule မှာ indefinitely retained quarantine ဟု နာမည်ပြောင်းရုံဖြင့် disposal
progress သို့မဟုတ် bounded retention ကို မသက်သေပြနိုင်ပါ။ Socket closure က pool removal
သို့မဟုတ် transaction outcome proof မဟုတ်ပါ။

ထို့ကြောင့် S1 implementation ကို **BLOCKED** ဟု သတ်မှတ်ထားသည်။ Owner candidate ကို
မတင်ထားပါ။ Typed outcomes, cancellation, proof-precedence primitives နှင့် repaired
release behavior ကို implemented ဟု မဆိုပါ။ D04/S2–S6 မစတင်ပါ။

Corrected S0-03/S0-04 assertions နှင့် unit regressions ကို red gate အဖြစ် ထိန်းထားသည်။
Current owner သည် ROLLBACK-tag callback success နှင့် post-COMMIT release-error masking
နှစ်ခုလုံးတွင် unsafe ဖြစ်ဆဲဖြစ်သည်။ Historical PR #12 ကို မပြောင်းပါ။

## Next decision required

Consumed-release failure အတွက် audited, idempotent disposal/removal contract ပါသည့်
narrow pool adapter သို့မဟုတ် verified upstream driver fix ကို သီးခြား review လုပ်ရန်လိုသည်။
Private pool fields ကို production မှ ခေါ်ခြင်း၊ arbitrary synthetic error events ဖြင့်
pool bookkeeping ကို အတင်းပြောင်းခြင်း၊ double release သို့မဟုတ် indefinite quarantine ကို
successful disposal ဟု သတ်မှတ်ခြင်းကို remediation အဖြစ် မယူပါ။

S1 acceptance matrix အပြည့်၊ cancellation/deadline/security tests နှင့် successful
exact-head full CI မပြီးသေးပါ။ `SIGNUP_ENABLED=false`; AUTH-001 မပြီးသေးပါ။
Draft PR ကို merge/approve/ready မလုပ်ရပါ။
