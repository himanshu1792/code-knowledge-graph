package com.example.shop.domain;

import jakarta.persistence.*;

@Entity
public class Address {

    @Id
    @GeneratedValue
    private Long id;

    @Column
    private String city;
}
