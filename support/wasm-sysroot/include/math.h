#ifndef DPRINT_CLANG_FORMAT_WASM_MATH_H
#define DPRINT_CLANG_FORMAT_WASM_MATH_H

#define FP_NAN 0
#define FP_INFINITE 1
#define FP_ZERO 2
#define FP_SUBNORMAL 3
#define FP_NORMAL 4

#define FP_ILOGBNAN (-1 - 0x7fffffff)
#define FP_ILOGB0 FP_ILOGBNAN

#define HUGE_VAL (__builtin_huge_val())
#define HUGE_VALF (__builtin_huge_valf())
#define HUGE_VALL (__builtin_huge_vall())
#define INFINITY (__builtin_inff())
#define NAN (__builtin_nanf(""))

#ifdef __cplusplus
extern "C" {
#endif

double fabs(double value);
float fabsf(float value);
long double fabsl(long double value);
double modf(double value, double *integer_part);

#ifdef __cplusplus
}
#endif

#endif
