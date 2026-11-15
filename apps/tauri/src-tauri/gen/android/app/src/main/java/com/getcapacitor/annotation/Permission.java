package com.getcapacitor.annotation;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/** Groupe de permissions Android désigné par un alias. */
@Retention(RetentionPolicy.RUNTIME)
public @interface Permission {
    String[] strings() default {};

    String alias() default "";
}
