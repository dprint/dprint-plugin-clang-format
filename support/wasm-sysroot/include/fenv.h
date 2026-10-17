#ifndef DPRINT_CLANG_FORMAT_WASM_FENV_H
#define DPRINT_CLANG_FORMAT_WASM_FENV_H

// wasm has no floating-point exception flags and only rounds to nearest
#define FE_ALL_EXCEPT 0
#define FE_TONEAREST 0

typedef unsigned short fexcept_t;
typedef struct {
  unsigned long __unused;
} fenv_t;

#ifdef __cplusplus
extern "C" {
#endif

int feclearexcept(int excepts);
int fegetexceptflag(fexcept_t *flags, int excepts);
int feraiseexcept(int excepts);
int fesetexceptflag(const fexcept_t *flags, int excepts);
int fetestexcept(int excepts);
int fegetround(void);
int fesetround(int rounding_mode);

#ifdef __cplusplus
}
#endif

#endif
