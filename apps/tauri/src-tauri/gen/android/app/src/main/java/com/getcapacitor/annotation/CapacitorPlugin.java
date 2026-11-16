package com.getcapacitor.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Nom du plugin vu du JS et permissions Android qu'il peut demander, comme dans Capacitor. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface CapacitorPlugin {
    String name() default "";

    Permission[] permissions() default {};
}
