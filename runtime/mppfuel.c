/* mppfuel.c -- Tempo fuel: a race's distance paid for as it is driven, over an MPP session (web/src/app/mppfuel.ts).
 *
 * Only when the page turns it on (IEV_MPP with dik MPP_ON) and only in a race of this game alone: never in free roam
 * (G_RACETYPE 0), a network race (G_NET_HOST / G_NET_CLIENT, where mprace.c owns the governor) or the career's free
 * roam, so the original game is untouched unless the player chose Tempo fuel.
 *
 * Each frame of a race that is running (G_RACE +0 == 4) this adds the player's car's speed (CAR_SPEED, m/s) times the
 * world's step (G_WORLDDT, s) to the race's distance and publishes it as the status counter "mpp_dist" (m), with
 * "mpp_race" (the race's number since boot, 0 while none runs) so the page can tell one race from the next.  The page
 * pays one voucher per MPP_METERS_PER_CAN of fuel ahead of the car and sends the total it holds (IEV_MPP, MPP_PAID,
 * a = metres).  With less than none left the car runs on its reserve: its governor (mprace_speed_limit, the stock
 * car's +0x2C0) at MPP_RESERVE_MPH until the next voucher lands; the governor it had is put back then and at the
 * race's end. */
#include "cpu.h"
#include "game.h"
#include "guest.h"
#include "mprace.h"
#include "splitscreen_mem.h"
#include "featurelist.h"
#include <stdio.h>
#include <stdint.h>

#define MPP_ON          1u
#define MPP_OFF         2u
#define MPP_PAID        3u
#define MPP_RESERVE_MPH 12.f          /* a crawl: the car still reaches the shoulder, it does not race */
#define RACE_RUNNING    4u
#define PI_LIMIT_OFF    0x2c0u        /* the car's physics info (car +0x10, +0x10): the governor in mph, 0 none */

__attribute__((weak)) int host_status_slot(const char *name){ (void)name; return -1; }
__attribute__((weak)) void host_status_set_n(const int *slot, const double *value, int n){ (void)slot; (void)value; (void)n; }

static volatile uint32_t g_on, g_paid_m;
static struct {
    int slot[2];
    uint32_t race, races, car;
    double dist;
    int limping;
    float governor;
} M = { { -2, -2 }, 0, 0, 0, 0.0, 0, 0.f };

void mppfuel_input(uint32_t what, int32_t a){
    if (what == MPP_ON) __atomic_store_n(&g_on, 1u, __ATOMIC_RELEASE);
    else if (what == MPP_OFF) __atomic_store_n(&g_on, 0u, __ATOMIC_RELEASE);
    else if (what == MPP_PAID && a >= 0) __atomic_store_n(&g_paid_m, (uint32_t)a, __ATOMIC_RELEASE);
}

static uint32_t player_car(void){
    uint32_t pl = guest_rd32(SPLIT_PLAYERS_INDEX), car = pl ? guest_rd32(pl + 4u) : 0;
    return car && guest_ok(car + CAR_SPEED, 3) ? car : 0;
}
static float governor(uint32_t car){
    uint32_t r = guest_rd32(car + 0x10u);
    return r && guest_ok(r + 0x10u + PI_LIMIT_OFF, 3) ? MRF32(r + 0x10u + PI_LIMIT_OFF) : 0.f;
}
static int solo_race(void){
    if (MR32(G_FLOW) != 6u || MR32(G_RACETYPE) == 0u) return 0;
    if ((int32_t)MR32(G_NET_HOST) > 0 || (int32_t)MR32(G_NET_CLIENT) > 0 || MR8(G_NET_ONLINE)) return 0;
    return guest_ok(MR32(G_RACE), 3);
}
static void publish(void){
    if (M.slot[0] == -2) M.slot[0] = host_status_slot("mpp_race");
    if (M.slot[1] == -2) M.slot[1] = host_status_slot("mpp_dist");
    if (M.slot[0] < 0 || M.slot[1] < 0) return;
    double v[2] = { (double)M.race, M.dist };
    host_status_set_n(M.slot, v, 2);
}
static void limp(uint32_t car, int on){
    if (on == M.limping || !car) return;
    if (on){ M.governor = governor(car); mprace_speed_limit(car, MPP_RESERVE_MPH); }
    else mprace_speed_limit(car, M.governor);
    M.limping = on;
    fprintf(stderr, "[mppfuel] race %u at %.0f m: %s\n", M.race, M.dist, on ? "out of paid fuel, on the reserve" : "fuel paid, the governor back");
}
static void end_race(void){
    if (!M.race) return;
    limp(M.car, 0);
    fprintf(stderr, "[mppfuel] race %u over: %.0f m driven, %u m paid\n", M.race, M.dist, __atomic_load_n(&g_paid_m, __ATOMIC_ACQUIRE));
    M.race = 0; M.car = 0; M.dist = 0.0;
    publish();
}

void mppfuel_frame(void){
    if (!__atomic_load_n(&g_on, __ATOMIC_ACQUIRE) || !solo_race()){ end_race(); return; }
    uint32_t car = player_car();
    if (!car){ end_race(); return; }
    if (!M.race || car != M.car){
        end_race();
        M.race = ++M.races; M.car = car; M.dist = 0.0;
        __atomic_store_n(&g_paid_m, 0u, __ATOMIC_RELEASE);
        fprintf(stderr, "[mppfuel] race %u: Tempo fuel on\n", M.race);
    }
    if (guest_rd32(MR32(G_RACE)) == RACE_RUNNING){
        float v = MRF32(car + CAR_SPEED), dt = MRF32(G_WORLDDT);
        if (v > 0.f && v < 200.f && dt > 0.f && dt < 0.5f) M.dist += (double)v * (double)dt;
    }
    limp(car, M.dist >= (double)__atomic_load_n(&g_paid_m, __ATOMIC_ACQUIRE));
    publish();
}
